import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_archive_runs_db_check_fast } from "./files_archive_runs.ts";
import { files_subtree_ops_db_delete, files_subtree_ops_db_insert } from "./files_subtree_ops_db.ts";
import { files_nodes_user_write_context } from "../server/files-write-policy.ts";
import {
	add_member,
	archive,
	count_queue,
	fixture,
	lock,
	read_activity,
	read_node,
	read_state,
	run_to_end,
	seed_tree,
	step,
	type Fixture,
} from "./files_archive_runs.setup.test.ts";

// A full check of the 127-item trees below must cross a step, so it cannot look like a fast stamp.
vi.mock("../server/files-archive-runs.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server/files-archive-runs.ts")>()),
	files_archive_runs_CHECK_STEP_MAX_NODES: 100,
}));

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function insert_copy(
	f: Fixture,
	args: {
		treePaths: string[];
		sourceTreePaths?: string[];
		blockedByOpId?: Id<"files_subtree_ops">;
		indexPending?: boolean;
	},
) {
	const opId = await f.t.run((ctx) =>
		files_subtree_ops_db_insert(ctx, {
			op: {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				kind: "copy",
				status: "queued",
				blockedByOpId: args.blockedByOpId ?? null,
				rootNodeIds: [],
				treePaths: args.treePaths,
				sourceTreePaths: args.sourceTreePaths ?? [],
				// These tests drive only the path jobs, never the queued Copy worker.
				transferRunId: "999999files_transfer_runs" as Id<"files_transfer_runs">,
			},
			now: Date.now(),
		}),
	);
	if (!args.indexPending) await finish_path_jobs(f);
	return opId;
}

async function finish_path_jobs(f: Fixture) {
	for (let count = 0; count < 100; count++) {
		const job = await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_jobs").first());
		if (!job) return;
		await f.t.mutation(internal.files_subtree_ops.path_index_advance, {
			jobId: job._id,
			generation: job.generation,
			step: job.step,
		});
	}
	throw new Error("The path index jobs did not finish");
}

async function check_fast(f: Fixture, nodeId: Id<"files_nodes">) {
	return await f.t.run(async (ctx) => {
		const membership = (await ctx.db.get("organizations_workspaces_users", f.db.membershipId))!;
		const node = (await ctx.db.get("files_nodes", nodeId))!;
		const before = await ctx.meta.getTransactionMetrics();
		const checked = await files_archive_runs_db_check_fast(ctx, {
			writeContext: files_nodes_user_write_context(f.db.userId),
			membership,
			nodes: [node],
			opCheck: "overlapping",
		});
		const after = await ctx.meta.getTransactionMetrics();
		return {
			isFast: checked.isFast,
			indexPending: checked.indexPending,
			refusalCount: checked.refusals.size,
			reads: after.documentsRead.used - before.documentsRead.used,
		};
	});
}

describe("files_archive_runs_db_check_fast path index", () => {
	test("more than 500 unrelated queued copies still allow a fast archive with few reads", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "selected", folderCount: 6, filesPerFolder: 20 });
		for (let index = 0; index < 520; index++) {
			await insert_copy(f, { treePaths: [`/noise-${String(index).padStart(4, "0")}/`] });
		}

		const checked = await check_fast(f, tree.topId);
		// Assert cost first: the old workspace scan must fail here, before its conservative answer.
		expect(checked.reads, "the overlap check must not read unrelated copies").toBeLessThan(100);
		expect(checked).toMatchObject({ isFast: true, indexPending: false, refusalCount: 0 });
		const archived = await archive(f, [tree.topId]);
		expect(archived._yay).toMatchObject({ isDone: false, waitingNodeIds: [], isChecking: false });
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
	}, 120_000);

	test.each(["destination", "source"] as const)("a queued copy blocks its %s path", async (place) => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "selected", folderCount: 1, filesPerFolder: 1 });
		await insert_copy(f, {
			treePaths: [place === "destination" ? "/selected/d0/f000.md" : "/elsewhere/"],
			sourceTreePaths: place === "source" ? ["/selected/"] : [],
		});

		expect(await check_fast(f, tree.topId)).toMatchObject({ isFast: false, indexPending: false });
	});

	test("a queued scope op blocks its path but leaves a sibling prefix clear", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "selected", folderCount: 0, filesPerFolder: 0 });
		const sibling = await seed_tree(f, { name: "selected-other", folderCount: 0, filesPerFolder: 0 });
		await f.t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					kind: "scope",
					status: "queued",
					blockedByOpId: null,
					rootNodeIds: [],
					treePaths: ["/selected/"],
				},
				now: Date.now(),
			}),
		);
		await finish_path_jobs(f);

		expect(await check_fast(f, tree.topId)).toMatchObject({ isFast: false, indexPending: false });
		expect(await check_fast(f, sibling.topId)).toMatchObject({ isFast: true, indexPending: false });
	});

	test("a running scope op still guards the whole workspace", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "selected", folderCount: 0, filesPerFolder: 0 });
		await f.t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					kind: "scope",
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [],
					treePaths: ["/elsewhere/"],
				},
				now: Date.now(),
			}),
		);

		expect(await check_fast(f, tree.topId)).toMatchObject({ isFast: false, indexPending: false });
	});
});

describe("archive_nodes while path records are pending", () => {
	test("waits without a folder walk, then excludes its own op and stamps after the index is complete", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "selected", folderCount: 6, filesPerFolder: 20 });
		await insert_copy(f, {
			treePaths: Array.from({ length: 70 }, (_, index) => `/noise-${index}/`),
			indexPending: true,
		});
		const archived = await archive(f, [tree.topId]);
		expect(archived._yay).toMatchObject({ isDone: false, waitingNodeIds: [tree.topId], isChecking: true });
		const job = archived._yay!;
		const op = (await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
				.unique(),
		))!;
		expect(await step(f, job.runId)).toMatchObject({ phase: "fast_check", pathIndexWaiting: true });
		expect(await count_queue(f, op._id), "no descendant walk starts while the index is incomplete").toBe(0);
		expect((await read_state(f)).nodes.every((node) => node.archiveOperationId === null)).toBe(true);

		const indexJob = (await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_jobs").first()))!;
		await f.t.mutation(internal.files_subtree_ops.path_index_advance, {
			jobId: indexJob._id,
			generation: indexJob.generation,
			step: indexJob.step,
		});
		await f.t.mutation(internal.files_subtree_ops.path_index_wake, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
		});
		expect(await step(f, job.runId)).toMatchObject({ phase: "fast_check", pathIndexWaiting: true });
		expect(await count_queue(f, op._id)).toBe(0);

		await finish_path_jobs(f);
		await f.t.mutation(internal.files_subtree_ops.path_index_wake, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
		});
		expect(await step(f, job.runId), "the archive's own busy path must not force a full check").toMatchObject({
			phase: "apply",
			pathIndexWaiting: false,
		});
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		await finish_path_jobs(f);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_subtree_op_paths")
					.withIndex("by_op_treePath", (q) => q.eq("opId", op._id))
					.collect(),
			),
		).toEqual([]);
	});

	test.each(["membership", "read-only"] as const)("rechecks %s after waiting", async (changed) => {
		const f = await fixture();
		const member = await add_member(f);
		const tree = await seed_tree(f, { name: "selected", folderCount: 6, filesPerFolder: 20 });
		await insert_copy(f, {
			treePaths: Array.from({ length: 5 }, (_, index) => `/noise-${index}/`),
			indexPending: true,
		});
		const archived = await member.asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: member.membershipId,
			nodeIds: [tree.topId],
		});
		const job = archived._yay!;
		expect(await step(f, job.runId)).toMatchObject({ phase: "fast_check", pathIndexWaiting: true });
		if (changed === "membership") {
			await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", member.membershipId, { active: false }));
		} else {
			await lock({ f, nodeId: tree.fileIds.at(-1)!, locked: true });
		}

		await finish_path_jobs(f);
		await f.t.mutation(internal.files_subtree_ops.path_index_wake, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
		});
		const ended = await run_to_end(f, job);
		expect(ended.activity).toMatchObject({
			status: "failed",
			errorMessage:
				changed === "membership"
					? "You can no longer change these files."
					: '"/selected/d5/f019.md" is read-only. Unlock it, then try again.',
		});
		expect((await read_state(f)).nodes.every((node) => node.archiveOperationId === null)).toBe(true);
	});

	test.each([false, true])("rechecks a restricted folder grant after waiting (removed: %s)", async (removed) => {
		const f = await fixture();
		const member = await add_member(f);
		const tree = await seed_tree(f, { name: "restricted", folderCount: 0, filesPerFolder: 0 });
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId: tree.topId,
			}),
		).toEqual({ _yay: null });
		const grant = {
			membershipId: f.db.membershipId,
			nodeId: tree.topId,
			principal: { kind: "user" as const, userId: member.userId },
		};
		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_grant, { ...grant, level: "write" })).toEqual({
			_yay: null,
		});
		await insert_copy(f, { treePaths: ["/unrelated/"], indexPending: true });
		const archived = await member.asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: member.membershipId,
			nodeIds: [tree.topId],
		});
		expect(archived._yay).toMatchObject({ isChecking: true, waitingNodeIds: [tree.topId] });
		const job = archived._yay!;
		// Membership and write access on the parent stay valid. Only this folder's grant changes.
		if (removed)
			expect(await f.asOwner.mutation(api.files_sharing.remove_node_share_grant, grant)).toEqual({ _yay: null });
		await finish_path_jobs(f);
		const ended = await run_to_end(f, job);
		const node = await read_node(f, tree.topId);
		if (removed) {
			expect(node.archiveOperationId, "a removed grant must prevent the deferred stamp").toBeNull();
			expect(ended.activity).toMatchObject({ status: "failed", errorMessage: "Permission denied" });
		} else {
			expect(node.archiveOperationId).not.toBeNull();
			expect(ended.activity.status).toBe("succeeded");
		}
	});

	test("a scope repair that starts during the wait makes the archive use the full check", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "selected", folderCount: 6, filesPerFolder: 20 });
		await insert_copy(f, {
			treePaths: Array.from({ length: 5 }, (_, index) => `/noise-${index}/`),
			indexPending: true,
		});
		const job = (await archive(f, [tree.topId]))._yay!;
		expect(await step(f, job.runId)).toMatchObject({ phase: "fast_check", pathIndexWaiting: true });
		const scopeOpId = await f.t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					kind: "scope",
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [],
					treePaths: ["/elsewhere/"],
				},
				now: Date.now(),
			}),
		);
		await finish_path_jobs(f);
		await f.t.mutation(internal.files_subtree_ops.path_index_wake, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
		});

		expect(await step(f, job.runId)).toMatchObject({ phase: "check", pathIndexWaiting: false });
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
		await f.t.run((ctx) => files_subtree_ops_db_delete(ctx, { opId: scopeOpId, now: Date.now() }));
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
	});

	test("a copy queued behind the waiting archive chooses the full check and cannot deadlock it", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "selected", folderCount: 6, filesPerFolder: 20 });
		await insert_copy(f, {
			treePaths: Array.from({ length: 5 }, (_, index) => `/noise-${index}/`),
			indexPending: true,
		});
		const job = (await archive(f, [tree.topId]))._yay!;
		const op = (await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
				.unique(),
		))!;
		const copyId = await insert_copy(f, {
			treePaths: ["/destination/"],
			sourceTreePaths: ["/selected/"],
			blockedByOpId: op._id,
			indexPending: true,
		});
		await finish_path_jobs(f);
		await f.t.mutation(internal.files_subtree_ops.path_index_wake, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
		});

		expect(await step(f, job.runId)).toMatchObject({ phase: "check", pathIndexWaiting: false });
		expect(await count_queue(f, op._id)).toBeGreaterThan(0);
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		expect(await f.t.run((ctx) => ctx.db.get("files_subtree_ops", copyId))).toMatchObject({ blockedByOpId: null });
	});

	test("cleanup keeps its marker after the copy ends and wakes Trash when the old paths are gone", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "selected", folderCount: 6, filesPerFolder: 20 });
		const copyId = await insert_copy(f, {
			treePaths: ["/selected/", ...Array.from({ length: 5 }, (_, index) => `/noise-${index}/`)],
		});
		await f.t.run((ctx) => files_subtree_ops_db_delete(ctx, { opId: copyId, now: Date.now() }));
		expect(await f.t.run((ctx) => ctx.db.get("files_subtree_ops", copyId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_jobs").first())).not.toBeNull();
		const job = (await archive(f, [tree.topId]))._yay!;
		expect(await step(f, job.runId)).toMatchObject({ phase: "fast_check", pathIndexWaiting: true });
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();

		await finish_path_jobs(f);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_inputs").collect())).toEqual([]);
		await f.t.mutation(internal.files_subtree_ops.path_index_wake, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
		});
		expect(await step(f, job.runId)).toMatchObject({ phase: "apply", pathIndexWaiting: false });
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		await finish_path_jobs(f);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_paths").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_jobs").collect())).toEqual([]);
		expect((await read_activity(f, job.activityId)).status).toBe("succeeded");
	});
});
