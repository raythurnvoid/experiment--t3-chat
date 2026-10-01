import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	files_subtree_ops_db_delete,
	files_subtree_ops_db_find_blocker,
	files_subtree_ops_db_insert,
	files_subtree_ops_db_schedule_step,
} from "./files_subtree_ops.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

// Scheduled promotes never run on their own under fake timers. The tests read them from the schedule.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	return {
		t,
		db,
		scope: { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId },
		asOwner: t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId }),
	};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function insert_node(args: {
	ctx: MutationCtx;
	f: Fixture;
	fields: {
		parent: Doc<"files_nodes"> | null;
		name: string;
		kind: "file" | "folder";
		archiveOperationId: string | null;
	};
}) {
	const { ctx, f, fields } = args;

	const path = `${fields.parent?.path ?? ""}/${fields.name}`;
	const nodeId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: f.scope.organizationId,
		workspaceId: f.scope.workspaceId,
		createdBy: f.scope.userId,
		updatedBy: f.scope.userId,
		parentId: fields.parent?._id ?? "root",
		name: fields.name,
		sortName: files_sort_text_key(fields.name),
		kind: fields.kind,
		path,
		treePath: fields.kind === "folder" ? `${path}/` : path,
		pathDepth: path.split("/").length - 1,
		archiveOperationId: fields.archiveOperationId,
	});
	return (await ctx.db.get("files_nodes", nodeId))!;
}

/**
 * Restrict `nodeId`, then run the steps of its scope op to the end. `afterStep` gets the node ids in
 * the op's queue and the walk's next queue number, after the request and after each step.
 */
async function restrict_to_end(args: {
	f: Fixture;
	nodeId: Id<"files_nodes">;
	afterStep: (queued: Array<Id<"files_nodes">>, sequence: number) => void | Promise<void>;
}) {
	const { f, afterStep, nodeId} = args;

	const restricted = await f.asOwner.mutation(api.files_sharing.restrict_node, {
		membershipId: f.db.membershipId,
		nodeId,
	});
	expect(restricted._nay).toBeUndefined();
	for (let count = 0; count < 200; count++) {
		const state = await f.t.run(async (ctx) => {
			const op = await ctx.db.query("files_subtree_ops").first();
			if (!op) return null;
			const walk = await ctx.db
				.query("files_subtree_op_walks")
				.withIndex("by_op", (q) => q.eq("opId", op._id))
				.unique();
			const rows = (await ctx.db.query("files_subtree_op_nodes").collect()).filter((row) => row.opId === op._id);
			return { opId: op._id, step: walk!.step, sequence: walk!.sequence, queued: rows.map((row) => row.nodeId) };
		});
		if (!state) return;
		await afterStep(state.queued, state.sequence);
		await f.t.mutation(internal.files_subtree_ops.advance, { opId: state.opId, step: state.step });
	}
	throw new Error("The scope op did not finish");
}

async function insert_scope_op(
	ctx: MutationCtx,
	args: {
		scope: Pick<Doc<"files_subtree_ops">, "organizationId" | "workspaceId" | "userId">;
		treePath: string;
		status: Doc<"files_subtree_ops">["status"];
		blockedByOpId: Id<"files_subtree_ops"> | null;
	},
) {
	return await files_subtree_ops_db_insert(ctx, {
		op: {
			kind: "scope",
			...args.scope,
			status: args.status,
			blockedByOpId: args.blockedByOpId,
			rootNodeIds: [],
			treePaths: [args.treePath],
		},
		now: Date.now(),
	});
}

describe("files_subtree_ops schema", () => {
	test("refuses a move op without its old paths", async () => {
		const { t, scope } = await fixture();
		const move = {
			kind: "move" as const,
			...scope,
			status: "running" as const,
			blockedByOpId: null,
			rootNodeIds: [],
			treePaths: ["/b/a/"],
		};

		// @ts-expect-error A move op must keep the paths its roots had before.
		await expect(t.run((ctx) => ctx.db.insert("files_subtree_ops", move))).rejects.toThrow("Validator error");
		expect(await t.run((ctx) => ctx.db.insert("files_subtree_ops", { ...move, oldTreePaths: ["/a/"] }))).toBeTruthy();
	});
});

describe("files_subtree_ops_db_schedule_step", () => {
	test("schedules a short retry for the same step", async () => {
		const { t, scope } = await fixture();
		const opId = await t.run((ctx) =>
			insert_scope_op(ctx, { scope, treePath: "/docs/", status: "running", blockedByOpId: null }),
		);
		const startedAt = Date.now();
		await t.run((ctx) => files_subtree_ops_db_schedule_step(ctx, { opId, now: startedAt }));
		const scheduled = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect())
				.filter((job) => job.name === "files_subtree_ops:advance")
				.map((job) => ({ step: (job.args[0] as { step: number }).step, scheduledTime: job.scheduledTime }))
				.toSorted((a, b) => a.scheduledTime - b.scheduledTime),
		);
		expect(scheduled).toEqual([
			{ step: 1, scheduledTime: startedAt },
			{ step: 1, scheduledTime: startedAt + 60_000 },
		]);
	});
});

describe("files_subtree_ops_db_find_blocker", () => {
	test("a move is busy on its old path too, and a longer sibling name does not overlap", async () => {
		const { t, scope } = await fixture();
		const moveId = await t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					kind: "move",
					...scope,
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [],
					treePaths: ["/b/a/"],
					oldTreePaths: ["/a/"],
				},
				now: Date.now(),
			}),
		);

		const find = (treePaths: string[]) =>
			t.run(async (ctx) => (await files_subtree_ops_db_find_blocker(ctx, { ...scope, treePaths, waiter: null }))?._id);
		expect(await find(["/a/x/"])).toBe(moveId);
		expect(await find(["/b/"])).toBe(moveId);
		expect(await find(["/a-other/"])).toBeNull();
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" }),
		);
		expect(
			await t.run(async (ctx) =>
				files_subtree_ops_db_find_blocker(ctx, {
					organizationId: other.organizationId,
					workspaceId: other.workspaceId,
					treePaths: ["/a/"],
					waiter: null,
				}),
			),
		).toBeNull();
	});

	test("a file path holds no other path", async () => {
		const { t, scope } = await fixture();
		const scopeId = await t.run((ctx) =>
			insert_scope_op(ctx, { scope, treePath: "/docs/a.md", status: "running", blockedByOpId: null }),
		);

		const find = (treePaths: string[]) =>
			t.run(async (ctx) => (await files_subtree_ops_db_find_blocker(ctx, { ...scope, treePaths, waiter: null }))?._id);
		expect(await find(["/docs/a.md"])).toBe(scopeId);
		expect(await find(["/docs/"])).toBe(scopeId);
		expect(await find(["/docs/a.md-old/"])).toBeNull();
		expect(await find(["/docs/a.md-old"])).toBeNull();
	});
});

describe("advance", () => {
	test("a step that only clears empty and deleted folders from the queue stops near the limits", async () => {
		const { t, scope } = await fixture();
		const opId = await t.run((ctx) => insert_scope_op(ctx, { scope, treePath: "/", status: "running", blockedByOpId: null }));
		// Each deleted folder costs the step 2 reads and each empty folder 3. Together they are more than
		// the 4,096 reads one mutation may do.
		for (const isDeleted of [true, false]) {
			await t.run(async (ctx) => {
				for (let index = 0; index < 1200; index++) {
					const name = `${isDeleted ? "deleted" : "empty"}-${index}`;
					const nodeId = await ctx.db.insert("files_nodes", {
						...test_mocks.files.base(),
						organizationId: scope.organizationId,
						workspaceId: scope.workspaceId,
						createdBy: scope.userId,
						updatedBy: scope.userId,
						parentId: "root",
						name,
						sortName: files_sort_text_key(name),
						path: `/${name}`,
						treePath: `/${name}/`,
						pathDepth: 1,
					});
					if (isDeleted) await ctx.db.delete("files_nodes", nodeId);
					await ctx.db.insert("files_subtree_op_nodes", {
						opId,
						// Take these rows before the walk rows, which get small numbers.
						sequence: 1_000_000 + (isDeleted ? 0 : 1200) + index,
						nodeId,
						nodeDone: true,
						cursor: null,
						pending: [],
					});
				}
			});
		}

		const read_walk = () =>
			t.run(async (ctx) => ({
				op: await ctx.db.get("files_subtree_ops", opId),
				step: (await ctx.db.query("files_subtree_op_walks").withIndex("by_op", (q) => q.eq("opId", opId)).unique())
					?.step,
				queued: (await ctx.db.query("files_subtree_op_nodes").withIndex("by_op_sequence", (q) => q.eq("opId", opId)).collect())
					.length,
			}));

		await expect(t.mutation(internal.files_subtree_ops.advance, { opId, step: 0 })).resolves.toBeNull();
		const afterFirstStep = await read_walk();
		expect(afterFirstStep).toMatchObject({ step: 1 });
		expect(afterFirstStep.queued).toBeGreaterThan(0);
		expect(afterFirstStep.queued).toBeLessThan(2400);

		for (let count = 0; count < 10 && (await read_walk()).op; count++) {
			await t.mutation(internal.files_subtree_ops.advance, { opId, step: (await read_walk()).step! });
		}
		expect(await read_walk()).toEqual({ op: null, step: undefined, queued: 0 });
	}, 120_000);

	test("walks into the folders of a page before their siblings' folders, so the queue stays small", async () => {
		const f = await fixture();
		const top = await f.t.run(async (ctx) => {
			const top = await insert_node({ ctx, f, fields: { parent: null, name: "top", kind: "folder", archiveOperationId: null } });
			for (let index = 0; index < 30; index++) {
				const child = await insert_node({
					ctx,
					f,
					fields: {
					parent: top,
					name: `d${index}`,
					kind: "folder",
					archiveOperationId: null,
				},
				});
				for (let grandchildIndex = 0; grandchildIndex < 60; grandchildIndex++) {
					await insert_node({
						ctx,
						f,
						fields: {
						parent: child,
						name: `e${grandchildIndex}`,
						kind: "folder",
						archiveOperationId: null,
					},
					});
				}
			}
			return top;
		});

		// The queue holds `/top`, its 30 folders, and one page of 50 folders of the folder the walk is in.
		// If the walk took the oldest row first, the queue would hold the folders of every `/top/d*` folder
		// at once.
		let largestQueue = 0;
		await restrict_to_end({
			f,
			nodeId: top._id,
			afterStep: (queued) => {
			largestQueue = Math.max(largestQueue, queued.length);
		},
		});
		expect(largestQueue).toBeLessThanOrEqual(1 + 30 + 50);

		const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(nodes.filter((node) => node.restrictedScopeNodeId !== top._id)).toEqual([]);
	}, 120_000);

	test("a step that stops inside a group of folders with one name queues each folder once", async () => {
		const f = await fixture();
		// Each replace of a folder archives the old one, so a folder can hold many archived folders with one
		// name. Their files keep the steps busy, so a step ends while their folders are still queued. The
		// 50 files before them fill the first page, so the group starts on the second page.
		const top = await f.t.run(async (ctx) => {
			const top = await insert_node({ ctx, f, fields: { parent: null, name: "top", kind: "folder", archiveOperationId: null } });
			for (let index = 0; index < 50; index++) {
				await insert_node({
					ctx,
					f,
					fields: {
					parent: top,
					name: `a${String(index).padStart(2, "0")}.md`,
					kind: "file",
					archiveOperationId: null,
				},
				});
			}
			for (let index = 0; index < 100; index++) {
				const archiveOperationId = `replace-${index}`;
				const old = await insert_node({ ctx, f, fields: { parent: top, name: "old", kind: "folder", archiveOperationId } });
				for (const name of ["a.md", "b.md"]) {
					await insert_node({ ctx, f, fields: { parent: old, name, kind: "file", archiveOperationId } });
				}
			}
			return top;
		});

		const twice: Array<Id<"files_nodes">> = [];
		const firstPass: Array<{ sequence: number; rewrittenFolders: number }> = [];
		await restrict_to_end({
			f,
			nodeId: top._id,
			afterStep: async (queued, sequence) => {
			twice.push(...queued.filter((nodeId, index) => queued.indexOf(nodeId) !== index));

			// A step rewrites a folder and queues it in the same mutation. So while the first pass runs, the
			// walk has used one queue number for `/top` and one for each rewritten folder. A step that read a
			// page again would queue some folders a second time, even when the first row is already gone.
			const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			if (nodes.every((node) => node.restrictedScopeNodeId === top._id)) return;
			firstPass.push({
				sequence,
				rewrittenFolders: nodes.filter(
					(node) => node.kind === "folder" && node._id !== top._id && node.restrictedScopeNodeId === top._id,
				).length,
			});
		},
		});
		expect(twice).toEqual([]);
		expect(firstPass.length).toBeGreaterThan(1);
		expect(firstPass.filter((state) => state.sequence !== 1 + state.rewrittenFolders)).toEqual([]);

		const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(nodes.filter((node) => node.restrictedScopeNodeId !== top._id)).toEqual([]);
	}, 120_000);

	test("reads every child of a group that shares a name and a creation time", async () => {
		const f = await fixture();
		const top = await f.t.run((ctx) =>
			insert_node({ ctx, f, fields: { parent: null, name: "top", kind: "folder", archiveOperationId: null } }),
		);
		// `8.64e15` is the largest time a date can hold, and `8.64e15 + 0.001` is `8.64e15` again. So the
		// test clock cannot move the creation time of the next node forward, and all of them get one time.
		const now = Date.now();
		vi.setSystemTime(8.64e15);
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 120; index++) {
				await insert_node({
					ctx,
					f,
					fields: { parent: top, name: "old.md", kind: "file", archiveOperationId: `replace-${index}` },
				});
			}
		});
		vi.setSystemTime(now);
		const tied = await f.t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect()).filter((node) => node.name === "old.md"),
		);
		expect(new Set(tied.map((node) => node._creationTime))).toEqual(new Set([8.64e15]));

		await restrict_to_end({ f, nodeId: top._id, afterStep: () => {} });

		const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(nodes.filter((node) => node.restrictedScopeNodeId !== top._id).map((node) => node.name)).toEqual([]);
	}, 120_000);
});

describe("files_subtree_ops_db_delete", () => {
	test("starts the waiters that no longer overlap, and the third waits for the first", async () => {
		const { t, scope } = await fixture();
		const ids = await t.run(async (ctx) => {
			const blockerId = await insert_scope_op(ctx, {
				scope,
				treePath: "/docs/",
				status: "running",
				blockedByOpId: null,
			});
			return {
				blockerId,
				firstId: await insert_scope_op(ctx, {
					scope,
					treePath: "/docs/a/",
					status: "queued",
					blockedByOpId: blockerId,
				}),
				secondId: await insert_scope_op(ctx, {
					scope,
					treePath: "/docs/b/",
					status: "queued",
					blockedByOpId: blockerId,
				}),
				thirdId: await insert_scope_op(ctx, {
					scope,
					treePath: "/docs/a/x/",
					status: "queued",
					blockedByOpId: blockerId,
				}),
			};
		});

		await t.run((ctx) => files_subtree_ops_db_delete(ctx, { opId: ids.blockerId, now: Date.now() }));

		const after = await t.run(async (ctx) => ({
			first: await ctx.db.get("files_subtree_ops", ids.firstId),
			second: await ctx.db.get("files_subtree_ops", ids.secondId),
			third: await ctx.db.get("files_subtree_ops", ids.thirdId),
			promotedOpIds: (await ctx.db.system.query("_scheduled_functions").collect())
				.filter((job) => job.name === "files_subtree_ops:promote")
				.map((job) => (job.args[0] as { opId: Id<"files_subtree_ops"> }).opId),
		}));
		expect(after.first).toMatchObject({ blockedByOpId: null });
		expect(after.second).toMatchObject({ blockedByOpId: null });
		expect(after.third).toMatchObject({ blockedByOpId: ids.firstId });
		expect(after.promotedOpIds.sort()).toEqual([ids.firstId, ids.secondId].sort());
	});

	test("many waiters behind an op on `/` all start, over more than one mutation", async () => {
		const { t, scope } = await fixture();
		// A restore of many top items can mark `/` busy. Each waiter's check reads every op, so 200 waiters
		// cost about 40,000 reads, more than the 32,000 one mutation may do.
		const { blockerId, waiterIds } = await t.run(async (ctx) => {
			const blockerId = await insert_scope_op(ctx, { scope, treePath: "/", status: "running", blockedByOpId: null });
			const waiterIds = [];
			for (let index = 0; index < 200; index++) {
				waiterIds.push(
					await insert_scope_op(ctx, {
						scope,
						treePath: `/w-${String(index).padStart(3, "0")}/`,
						status: "queued",
						blockedByOpId: blockerId,
					}),
				);
			}
			return { blockerId, waiterIds };
		});
		const read_waiting = () =>
			t.run(async (ctx) =>
				(await ctx.db.query("files_subtree_ops").collect()).filter((op) => op.blockedByOpId === blockerId).length,
			);

		await expect(t.mutation(internal.files_subtree_ops.advance, { opId: blockerId, step: 0 })).resolves.toBeNull();
		expect(await read_waiting()).toBeGreaterThan(0);
		for (let count = 0; (await read_waiting()) > 0; count++) {
			if (count === 10) throw new Error("The waiters did not start");
			await t.mutation(internal.files_subtree_ops.release_waiters, { opId: blockerId });
		}

		const promotedOpIds = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect())
				.filter((job) => job.name === "files_subtree_ops:promote")
				.map((job) => (job.args[0] as { opId: Id<"files_subtree_ops"> }).opId),
		);
		expect(promotedOpIds.sort()).toEqual(waiterIds.sort());
	}, 120_000);
});
