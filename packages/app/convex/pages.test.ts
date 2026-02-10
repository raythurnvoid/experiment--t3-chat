import { expect, test } from "vitest";
import { internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with, test_mocks_hardcoded } from "./setup.test.ts";
import { math_clamp } from "../shared/shared-utils.ts";
import { minimatch } from "minimatch";
import { server_path_normalize } from "../server/server-utils.ts";
import type { ActionCtx } from "./_generated/server";

test("list_pages", async () => {
	const t = test_convex();

	await t.run(async (ctx) => {
		const db = await test_mocks_fill_db_with.nested_pages(ctx);

		const result_list_root = await list_dir(ctx as any, {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			path: "/",
		});

		expect(result_list_root.items).toHaveLength(Object.keys(db.pages).length);

		expect(result_list_root.items[0]).toStrictEqual({
			path: `/${db.pages.page_root_1.name}`,
			updatedAt: db.pages.page_root_1.updatedAt,
		});

		// The list must be depth-first
		expect(result_list_root.items[1]).toStrictEqual({
			path: `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}`,
			updatedAt: db.pages.page_root_1_child_1.updatedAt,
		});
		expect(result_list_root.items[2]).toStrictEqual({
			path: `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}/${db.pages.page_root_1_child_1_deep_1.name}`,
			updatedAt: db.pages.page_root_1_child_1_deep_1.updatedAt,
		});

		const result_list_page_root_1 = await list_dir(ctx as any, {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			path: `/${db.pages.page_root_1.name}`,
		});

		expect(result_list_page_root_1.items).toHaveLength(
			[db.pages.page_root_1_child_1, db.pages.page_root_1_child_1_deep_1, db.pages.page_root_1_child_2].length,
		);

		// The list must be depth-first
		expect(result_list_page_root_1.items[0]).toStrictEqual({
			path: `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}`,
			updatedAt: db.pages.page_root_1_child_1.updatedAt,
		});
	});
});

test("list_pages_new", async () => {
	const t = test_convex();

	await t.run(async (ctx) => {
		const db = await test_mocks_fill_db_with.nested_pages(ctx);

		const result_root = await ctx.runQuery(internal.ai_docs_temp.list_pages, {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			path: "/",
			maxDepth: 10,
			limit: 100,
		});

		expect(result_root.items).toHaveLength(Object.keys(db.pages).length);

		expect(result_root.items[0], "The first result must be the first page at the root").toStrictEqual({
			path: `/${db.pages.page_root_1.name}`,
			updatedAt: db.pages.page_root_1.updatedAt,
			depthTruncated: false,
		});

		expect(result_root.items[1], "The list must be depth-first").toStrictEqual({
			path: `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}`,
			updatedAt: db.pages.page_root_1_child_1.updatedAt,
			depthTruncated: false,
		});
		expect(result_root.items[2], "The list must be depth-first").toStrictEqual({
			path: `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}/${db.pages.page_root_1_child_1_deep_1.name}`,
			updatedAt: db.pages.page_root_1_child_1_deep_1.updatedAt,
			depthTruncated: false,
		});

		expect(result_root.truncated).toBe(false);

		const result_under_root1 = await ctx.runQuery(internal.ai_docs_temp.list_pages, {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			path: `/${db.pages.page_root_1.name}`,
			maxDepth: 10,
			limit: 100,
		});

		expect(result_under_root1.items).toHaveLength(
			[db.pages.page_root_1_child_1, db.pages.page_root_1_child_1_deep_1, db.pages.page_root_1_child_2].length,
		);

		expect(result_under_root1.items[0], "The first result must be the first child of the root").toStrictEqual({
			path: `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}`,
			updatedAt: db.pages.page_root_1_child_1.updatedAt,
			depthTruncated: false,
		});

		// Depth truncation flagging: with maxDepth 1, the first child with deeper matches should be marked
		const result_depth1 = await ctx.runQuery(internal.ai_docs_temp.list_pages, {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			path: "/",
			maxDepth: 1,
			limit: 100,
		});

		expect(result_depth1.items[1]).toStrictEqual({
			path: `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}`,
			updatedAt: db.pages.page_root_1_child_1.updatedAt,
			depthTruncated: true,
		});
	});
});

async function list_dir(
	ctx: ActionCtx,
	args: {
		workspaceId: string;
		projectId: string;
		path: string;
		maxDepth?: number;
		limit?: number;
		include?: string;
	},
): Promise<{ items: Array<{ path: string; updatedAt: number }>; metadata: { count: number; truncated: boolean } }> {
	// Resolve the starting node id for the provided path
	const startNodeId = await ctx.runQuery(internal.ai_docs_temp.resolve_tree_node_id_from_path, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		path: args.path,
	});
	if (!startNodeId) return { items: [], metadata: { count: 0, truncated: false } };

	// Normalize base path to an absolute path string (leading slash, no trailing slash except root)
	const basePath = server_path_normalize(args.path);

	const maxDepth = args.maxDepth ? math_clamp(args.maxDepth, 0, 10) : 5;
	const limit = args.limit ? math_clamp(args.limit, 1, 100) : 100;

	const resultPaths: Array<{ path: string; updatedAt: number }> = [];
	let truncated = false;

	// Depth-first traversal using an explicit stack. Each frame carries a pagination cursor
	// so we fetch one child at a time for the current parent, then dive deeper first.
	const stack: Array<{ parentId: string; absPath: string; cursor: string | null; depth: number }> = [
		{ parentId: startNodeId, absPath: basePath, cursor: null, depth: 0 },
	];

	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) continue;

		const paginatedResult = await ctx.runQuery(internal.ai_docs_temp.get_page_info_for_list_dir_pagination, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: frame.parentId,
			cursor: frame.cursor,
		});

		// No more children at this cursor for this parent or page is empty
		if (paginatedResult.isDone) continue;

		const child = paginatedResult.page.at(0);
		if (!child) continue; // just for type safety

		const childPath = frame.absPath === "/" ? `/${child.name}` : `${frame.absPath}/${child.name}`;

		// If include pattern is provided, only add items that match the glob
		const matchesInclude = args.include ? minimatch(childPath, args.include) : true;
		if (matchesInclude) {
			resultPaths.push({ path: childPath, updatedAt: child.updatedAt });

			// Respect limit if provided (only counts included items)
			if (resultPaths.length >= limit) {
				truncated = true;
				break;
			}
		}

		// First, if there are more siblings for the current parent, push the parent back with updated cursor
		// so we'll process siblings after we finish the deep dive into this child.
		if (!paginatedResult.isDone) {
			stack.push({
				parentId: frame.parentId,
				absPath: frame.absPath,
				cursor: paginatedResult.continueCursor,
				depth: frame.depth,
			});
		}

		// Then, push the child to dive deeper first (pre-order/JSON.stringify-like walk)
		const nextDepth = frame.depth + 1;
		if (nextDepth < maxDepth) {
			stack.push({ parentId: child.pageId, absPath: childPath, cursor: null, depth: nextDepth });
		}
	}

	return {
		items: resultPaths,
		metadata: {
			count: resultPaths.length,
			truncated,
		},
	};
}
