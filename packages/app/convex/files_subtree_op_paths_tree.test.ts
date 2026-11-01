import { describe, expect, test } from "vitest";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	files_subtree_op_paths_tree_delete,
	files_subtree_op_paths_tree_find_blocked,
	files_subtree_op_paths_tree_insert,
} from "./files_subtree_op_paths_tree.ts";

type Path = Doc<"files_subtree_op_paths">;

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId };
	const opIds = await t.run(async (ctx) => {
		const ids: Array<Id<"files_subtree_ops">> = [];
		for (let index = 0; index < 4; index++)
			ids.push(
				await ctx.db.insert("files_subtree_ops", {
					...scope,
					userId: db.userId,
					kind: "scope",
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [],
					treePaths: [],
				}),
			);
		return ids;
	});
	return { t, scope, opIds };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function overlaps(left: string, right: string) {
	return (
		left === right || (left.endsWith("/") && right.startsWith(left)) || (right.endsWith("/") && left.startsWith(right))
	);
}

/**
 * Inspect the whole small fixture so a broken link or stale endpoint cannot hide behind one query.
 */
async function expect_tree(f: Fixture, expected: Array<Pick<Path, "opId" | "treePath">>) {
	const paths = await f.t.run((ctx) =>
		ctx.db
			.query("files_subtree_op_paths")
			.withIndex("by_organization_workspace_parent", (q) =>
				q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId),
			)
			.collect(),
	);
	const key = (path: Pick<Path, "opId" | "treePath">) => `${path.treePath}\0${path.opId}`;
	expect(paths.map(key).sort()).toEqual(expected.map(key).sort());
	const byId = new Map(paths.map((path) => [path._id, path]));
	const visited = new Set<Id<"files_subtree_op_paths">>();
	const roots = paths.filter((path) => path.parentId === null);
	expect(roots).toHaveLength(paths.length === 0 ? 0 : 1);
	const end = (path: Path) => (path.treePath.endsWith("/") ? `${path.treePath.slice(0, -1)}0` : `${path.treePath}\0`);
	function visit(
		id: Id<"files_subtree_op_paths"> | null,
		parentId: Id<"files_subtree_op_paths"> | null,
	): { height: number; paths: Path[] } {
		if (id === null) return { height: 0, paths: [] };
		expect(visited.has(id), "a child link must not form a cycle").toBe(false);
		visited.add(id);
		const path = byId.get(id)!;
		expect(path.parentId).toBe(parentId);
		const left = visit(path.leftId, id);
		const right = visit(path.rightId, id);
		expect(left.paths.every((child) => key(child) < key(path))).toBe(true);
		expect(right.paths.every((child) => key(child) > key(path))).toBe(true);
		expect(Math.abs(left.height - right.height), "each subtree must stay balanced").toBeLessThanOrEqual(1);
		const height = 1 + Math.max(left.height, right.height);
		expect(path.height).toBe(height);
		const subtree = [...left.paths, path, ...right.paths];
		const best = byId.get(path.maxEndId!)!;
		expect(subtree.some((candidate) => candidate._id === best._id)).toBe(true);
		expect(end(best)).toBe(subtree.map(end).sort().at(-1));
		const other = subtree.filter((candidate) => candidate.opId !== best.opId);
		if (other.length === 0) expect(path.otherMaxEndId).toBeNull();
		else {
			const second = byId.get(path.otherMaxEndId!)!;
			expect(other.some((candidate) => candidate._id === second._id)).toBe(true);
			expect(end(second)).toBe(other.map(end).sort().at(-1));
		}
		return { height, paths: subtree };
	}
	if (roots[0]) visit(roots[0]._id, null);
	expect(visited.size).toBe(paths.length);
}

async function remove(f: Fixture, path: Pick<Path, "opId" | "treePath">) {
	await f.t.run(async (ctx) => {
		const doc = await ctx.db
			.query("files_subtree_op_paths")
			.withIndex("by_op_treePath", (q) => q.eq("opId", path.opId).eq("treePath", path.treePath))
			.unique();
		await files_subtree_op_paths_tree_delete(ctx, doc!);
	});
}

describe("files_subtree_op_paths_tree_insert", () => {
	test("keeps sorted inserts and root removals balanced with exact endpoint refs", async () => {
		const f = await fixture();
		const paths: Array<Pick<Path, "opId" | "treePath">> = [];
		for (let index = 0; index < 48; index++) {
			const path = { opId: f.opIds[index % f.opIds.length]!, treePath: `/item-${String(index).padStart(3, "0")}/` };
			paths.push(path);
			await f.t.run((ctx) => files_subtree_op_paths_tree_insert(ctx, { ...f.scope, ...path }));
			await expect_tree(f, paths);
		}
		const first = paths[0]!;
		await f.t.run((ctx) => files_subtree_op_paths_tree_insert(ctx, { ...f.scope, ...first }));
		await expect_tree(f, paths);
		while (paths.length > 0) {
			const root = (await f.t.run((ctx) =>
				ctx.db
					.query("files_subtree_op_paths")
					.withIndex("by_organization_workspace_parent", (q) =>
						q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId).eq("parentId", null),
					)
					.unique(),
			))!;
			await remove(f, root);
			paths.splice(
				paths.findIndex((path) => path.opId === root.opId && path.treePath === root.treePath),
				1,
			);
			await expect_tree(f, paths);
		}
	});
});

describe("files_subtree_op_paths_tree_find_blocked", () => {
	test("matches a prefix oracle through mixed inserts and deletes, including one excluded op", async () => {
		const f = await fixture();
		const queries = [
			"/",
			"/a",
			"/a/",
			"/a/b",
			"/a/b/",
			"/a/z",
			"/a-archive/",
			"/a0/",
			"/b/",
			"/b/z",
			"/😀/",
			"/😀/z",
			"/\uffff/",
			"/\uffff/z",
		];
		let seed = 42;
		const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
		const paths: Array<Pick<Path, "opId" | "treePath">> = [];
		for (let step = 0; step < 160; step++) {
			if (paths.length > 0 && random() < 0.4) {
				const [path] = paths.splice(Math.floor(random() * paths.length), 1);
				await remove(f, path!);
			} else {
				const path = {
					opId: f.opIds[Math.floor(random() * f.opIds.length)]!,
					treePath: queries[Math.floor(random() * queries.length)]!,
				};
				await f.t.run((ctx) => files_subtree_op_paths_tree_insert(ctx, { ...f.scope, ...path }));
				if (!paths.some((candidate) => candidate.opId === path.opId && candidate.treePath === path.treePath))
					paths.push(path);
			}
			await expect_tree(f, paths);
			for (const excludeOpId of [undefined, ...f.opIds]) {
				const blocked = await f.t.query((ctx) =>
					files_subtree_op_paths_tree_find_blocked(ctx, { ...f.scope, treePaths: queries, excludeOpId }),
				);
				expect(blocked).toEqual(
					queries.map((query) => paths.some((path) => path.opId !== excludeOpId && overlaps(path.treePath, query))),
				);
			}
		}
	});

	test("uses short lookups across deep paths and many unrelated or excluded paths", async () => {
		const f = await fixture();
		const self = f.opIds[0]!;
		const other = f.opIds[1]!;
		const deep = `/${"a/".repeat(510)}`;
		const long = `/${"x".repeat(4094)}/`;
		const covered = ["/covered/", deep, long];
		for (let index = 0; index < 620; index++) {
			await f.t.run((ctx) =>
				files_subtree_op_paths_tree_insert(ctx, {
					...f.scope,
					opId: index < 520 ? other : self,
					treePath: index < 520 ? `/noise-${String(index).padStart(4, "0")}/` : `/self/item-${index}/`,
				}),
			);
		}
		for (const treePath of covered)
			await f.t.run((ctx) => files_subtree_op_paths_tree_insert(ctx, { ...f.scope, opId: other, treePath }));
		await f.t.run((ctx) => files_subtree_op_paths_tree_insert(ctx, { ...f.scope, opId: self, treePath: "/self/" }));
		const queries = [
			"/covered/file",
			"/missing/",
			"/self/",
			"/self/item-555/",
			`${deep}leaf`,
			`${deep}other/`,
			`${long}leaf`,
			`${long}other/`,
			"/noise-0519/child",
			"/noise-0520/",
		];
		const result = await f.t.query(async (ctx) => ({
			blocked: await files_subtree_op_paths_tree_find_blocked(ctx, {
				...f.scope,
				treePaths: queries,
				excludeOpId: self,
			}),
			metrics: await ctx.meta.getTransactionMetrics(),
		}));
		expect(result.blocked).toEqual([true, false, false, false, true, true, true, true, true, false]);
		expect(result.metrics.databaseQueries.used, "ten lookups must not scan unrelated or excluded paths").toBeLessThan(
			160,
		);
		expect(result.metrics.bytesRead.used).toBeLessThan(1024 * 1024);
	});

	test("keeps workspace roots separate and leaves no partial tree after rollback", async () => {
		const f = await fixture();
		const another = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other-tree" }));
		const path = { ...f.scope, opId: f.opIds[0]!, treePath: "/docs/" };
		await f.t.run((ctx) => files_subtree_op_paths_tree_insert(ctx, path));
		expect(
			await f.t.query((ctx) =>
				files_subtree_op_paths_tree_find_blocked(ctx, {
					organizationId: another.organizationId,
					workspaceId: another.workspaceId,
					treePaths: ["/docs/"],
				}),
			),
		).toEqual([false]);
		await expect(
			f.t.run(async (ctx) => {
				await files_subtree_op_paths_tree_insert(ctx, { ...path, treePath: "/changed/" });
				throw new Error("Roll back the tree change");
			}),
		).rejects.toThrow("Roll back the tree change");
		await expect_tree(f, [path]);
	});
});
