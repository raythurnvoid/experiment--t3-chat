import { compareValues } from "convex/values";
import { expect, test } from "vitest";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_index_range_apply, files_index_range_phases } from "./files-index-range.ts";

test.each(["asc", "desc"] as const)("native seek omits an empty %s window", (order) => {
	for (const [start, end] of [[[1, 2], [1, 2]], [[2], [1]], [[1], [1, 2]]]) {
		expect(files_index_range_phases({ fields: ["updatedAt", "_creationTime"], order,
			start: start!, end: end!, startInclusive: false, endInclusive: true })).toEqual([]);
	}
});

test.each(["asc", "desc"] as const)("native seek keeps the complete key in %s order", async (order) => {
	const t = test_convex();
	const { scope, nodes } = await t.run(async (ctx) => {
		const scope = await test_mocks_fill_db_with.membership(ctx);
		const nodes = [];
		for (let index = 0; index < 24; index++) {
			const id = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
				updatedAt: Math.floor(index / 8),
				name: `file-${index}`,
			});
			nodes.push((await ctx.db.get("files_nodes", id))!);
		}
		return { scope, nodes };
	});
	const key = (node: (typeof nodes)[number]) => [node.updatedAt, node._creationTime, node._id];
	nodes.sort((a, b) => compareValues(key(a), key(b)));
	const start = key(nodes[5]!);
	const end = key(nodes[19]!);
	const phases = files_index_range_phases({
		fields: ["updatedAt", "_creationTime", "_id"], order, start, end,
		startInclusive: false, endInclusive: false,
	});
	const ids = [];
	for (const bounds of phases) {
		let cursor: string | null = null;
		while (true) {
			const page = await t.run((ctx) => ctx.db.query("files_nodes")
				.withIndex("by_organization_workspace_archiveOperation_updatedAt", (q) =>
					files_index_range_apply(q.eq("organizationId", scope.organizationId)
						.eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)
						.eq("archiveOperationId", null), bounds))
				.order(order).paginate({ cursor, numItems: 3 }));
			ids.push(...page.page.map((node) => node._id));
			if (page.isDone) break;
			cursor = page.continueCursor;
		}
	}
	const expected = nodes.slice(6, 19).map((node) => node._id);
	if (order === "desc") expected.reverse();
	expect(ids, "native phases return every row strictly inside the complete key window").toEqual(expected);
});
