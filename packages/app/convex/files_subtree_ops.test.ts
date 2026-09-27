import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	files_subtree_ops_db_delete,
	files_subtree_ops_db_find_blocker,
	files_subtree_ops_db_insert,
	files_subtree_ops_db_schedule_step,
} from "./files_subtree_ops.ts";

// Scheduled promotes never run on their own under fake timers. The tests read them from the schedule.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	return { t, scope: { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId } };
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
});
