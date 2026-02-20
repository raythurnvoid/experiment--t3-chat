import { expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with, test_mocks_hardcoded } from "./setup.test.ts";
import { math_clamp } from "../shared/shared-utils.ts";
import { minimatch } from "minimatch";
import { server_path_normalize } from "../server/server-utils.ts";
import type { ActionCtx } from "./_generated/server";
import { pages_ROOT_ID } from "../server/pages.ts";

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

test("resolve_page_id_from_path uses materialized paths", async () => {
	const t = test_convex();

	await t.run(async (ctx) => {
		const db = await test_mocks_fill_db_with.nested_pages(ctx);

		const root1Path = `/${db.pages.page_root_1.name}`;
		const child1Path = `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}`;
		const deep1Path = `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}/${db.pages.page_root_1_child_1_deep_1.name}`;

		const [root1Id, child1Id, deep1Id] = await Promise.all([
			ctx.runQuery(internal.ai_docs_temp.resolve_page_id_from_path, {
				workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
				projectId: test_mocks_hardcoded.project_id.project_1,
				path: root1Path,
			}),
			ctx.runQuery(internal.ai_docs_temp.resolve_page_id_from_path, {
				workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
				projectId: test_mocks_hardcoded.project_id.project_1,
				path: child1Path,
			}),
			ctx.runQuery(internal.ai_docs_temp.resolve_page_id_from_path, {
				workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
				projectId: test_mocks_hardcoded.project_id.project_1,
				path: deep1Path,
			}),
		]);

		expect(root1Id).toBe(db.pages.page_root_1._id);
		expect(child1Id).toBe(db.pages.page_root_1_child_1._id);
		expect(deep1Id).toBe(db.pages.page_root_1_child_1_deep_1._id);
	});
});

test("rename_page updates descendants materialized paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	const renamedRootName = "renamed_root";
	await asUser.mutation(api.ai_docs_temp.rename_page, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageId: db.pages.page_root_1._id,
		name: renamedRootName,
	});

	await t.run(async (ctx) => {
		const [renamedRoot, renamedChild, renamedDeep] = await Promise.all([
			ctx.db.get("pages", db.pages.page_root_1._id),
			ctx.db.get("pages", db.pages.page_root_1_child_1._id),
			ctx.db.get("pages", db.pages.page_root_1_child_1_deep_1._id),
		]);

		expect(renamedRoot?.path).toBe(`/${renamedRootName}`);
		expect(renamedChild?.path).toBe(`/${renamedRootName}/${db.pages.page_root_1_child_1.name}`);
		expect(renamedDeep?.path).toBe(
			`/${renamedRootName}/${db.pages.page_root_1_child_1.name}/${db.pages.page_root_1_child_1_deep_1.name}`,
		);
	});
});

test("move_pages updates descendants materialized paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.ai_docs_temp.move_pages, {
		itemIds: [db.pages.page_root_1_child_1._id],
		targetParentId: db.pages.page_root_2._id,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
	});

	await t.run(async (ctx) => {
		const [movedChild, movedDeep] = await Promise.all([
			ctx.db.get("pages", db.pages.page_root_1_child_1._id),
			ctx.db.get("pages", db.pages.page_root_1_child_1_deep_1._id),
		]);

		expect(movedChild?.path).toBe(`/${db.pages.page_root_2.name}/${db.pages.page_root_1_child_1.name}`);
		expect(movedDeep?.path).toBe(
			`/${db.pages.page_root_2.name}/${db.pages.page_root_1_child_1.name}/${db.pages.page_root_1_child_1_deep_1.name}`,
		);
	});
});

test("homepage path stays immutable on rename and move", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	const ensuredHomepage = await asUser.mutation(api.ai_docs_temp.ensure_home_page, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
	});
	if (ensuredHomepage._nay) {
		throw new Error("ensure_home_page failed in test");
	}
	const homepageId = ensuredHomepage._yay.pageId;

	await asUser.mutation(api.ai_docs_temp.rename_page, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageId: homepageId,
		name: "renamed_home",
	});

	await asUser.mutation(api.ai_docs_temp.move_pages, {
		itemIds: [homepageId],
		targetParentId: db.pages.page_root_1._id,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
	});

	await t.run(async (ctx) => {
		const homepage = await ctx.db.get("pages", homepageId);
		expect(homepage?.name).toBe("");
		expect(homepage?.path).toBe("/");
		expect(homepage?.parentId).toBe(pages_ROOT_ID);
	});
});

test("create_page rejects duplicate active path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	const duplicateCreation = await asUser.mutation(api.ai_docs_temp.create_page, {
		parentId: pages_ROOT_ID,
		name: db.pages.page_root_1.name,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
	});

	if (duplicateCreation._yay) {
		throw new Error("Expected duplicate creation to fail");
	}

	expect(duplicateCreation._nay.message).toContain("path already exists");
});

test("archived pages can share path with a new active page", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});
	const duplicateName = "archived_duplicate_allowed";

	const createdPage = await asUser.mutation(api.ai_docs_temp.create_page, {
		parentId: pages_ROOT_ID,
		name: duplicateName,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
	});
	if (createdPage._nay) {
		throw new Error("Expected initial page creation to succeed");
	}

	await asUser.mutation(api.ai_docs_temp.archive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [createdPage._yay.pageId],
	});

	const recreatedPage = await asUser.mutation(api.ai_docs_temp.create_page, {
		parentId: pages_ROOT_ID,
		name: duplicateName,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
	});
	if (recreatedPage._nay) {
		throw new Error("Expected recreated page creation to succeed");
	}

	await t.run(async (ctx) => {
		const path = `/${duplicateName}`;
		const pagesAtPath = await ctx.db
			.query("pages")
			.withIndex("by_workspaceId_projectId_path_archiveOperationId", (q) =>
				q
					.eq("workspaceId", test_mocks_hardcoded.workspace_id.workspace_1)
					.eq("projectId", test_mocks_hardcoded.project_id.project_1)
					.eq("path", path),
			)
			.collect();

		expect(pagesAtPath).toHaveLength(2);
		expect(pagesAtPath.filter((page) => page.archiveOperationId !== undefined)).toHaveLength(1);
		expect(pagesAtPath.filter((page) => page.archiveOperationId === undefined)).toHaveLength(1);
	});
});

test("rename_page returns conflict and keeps original path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	const renameResult = await asUser.mutation(api.ai_docs_temp.rename_page, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageId: db.pages.page_root_2._id,
		name: db.pages.page_root_1.name,
	});
	if (!("_nay" in renameResult)) {
		throw new Error("Expected rename to fail with path conflict");
	}

	const renameError = renameResult._nay;
	if (!renameError) {
		throw new Error("Expected rename error details");
	}
	expect(renameError.message).toContain("Path already exists");

	await t.run(async (ctx) => {
		const pageRoot2 = await ctx.db.get("pages", db.pages.page_root_2._id);
		expect(pageRoot2?.name).toBe(db.pages.page_root_2.name);
		expect(pageRoot2?.path).toBe(`/${db.pages.page_root_2.name}`);
	});
});

test("move_pages returns conflict and keeps original path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	const conflictingSibling = await asUser.mutation(api.ai_docs_temp.create_page, {
		parentId: db.pages.page_root_2._id,
		name: db.pages.page_root_1_child_1.name,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
	});
	if (conflictingSibling._nay) {
		throw new Error("Expected conflicting sibling creation to succeed");
	}

	const moveResult = await asUser.mutation(api.ai_docs_temp.move_pages, {
		itemIds: [db.pages.page_root_1_child_1._id],
		targetParentId: db.pages.page_root_2._id,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
	});
	if (!("_nay" in moveResult)) {
		throw new Error("Expected move to fail with path conflict");
	}

	const moveError = moveResult._nay;
	if (!moveError) {
		throw new Error("Expected move error details");
	}
	expect(moveError.message).toContain("Path already exists");

	await t.run(async (ctx) => {
		const child1 = await ctx.db.get("pages", db.pages.page_root_1_child_1._id);
		expect(child1?.parentId).toBe(db.pages.page_root_1._id);
		expect(child1?.path).toBe(`/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}`);
	});
});

test("unarchive_pages returns conflict when active page already has the same path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.ai_docs_temp.archive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_2._id],
	});

	const renameArchived = await asUser.mutation(api.ai_docs_temp.rename_page, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageId: db.pages.page_root_2._id,
		name: db.pages.page_root_1.name,
	});
	if (renameArchived._nay) {
		throw new Error("Expected archived rename to succeed");
	}

	const unarchiveResult = await asUser.mutation(api.ai_docs_temp.unarchive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_2._id],
	});
	if (!("_nay" in unarchiveResult)) {
		throw new Error("Expected unarchive to fail with path conflict");
	}

	const unarchiveError = unarchiveResult._nay;
	if (!unarchiveError) {
		throw new Error("Expected unarchive error details");
	}
	expect(unarchiveError.message).toContain("path already exists");

	await t.run(async (ctx) => {
		const pageRoot2 = await ctx.db.get("pages", db.pages.page_root_2._id);
		expect(pageRoot2?.archiveOperationId).not.toBeUndefined();
	});
});

test("unarchive_pages excludes unrequested ancestors from archive operation", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.ai_docs_temp.archive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_1._id],
	});

	const unarchiveResult = await asUser.mutation(api.ai_docs_temp.unarchive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_1_child_1._id],
	});
	if (unarchiveResult._nay) {
		throw new Error("Expected unarchive of child subtree to succeed");
	}

	await t.run(async (ctx) => {
		const pageRoot1 = await ctx.db.get("pages", db.pages.page_root_1._id);
		const pageRoot1Child1 = await ctx.db.get("pages", db.pages.page_root_1_child_1._id);
		const pageRoot1Child1Deep1 = await ctx.db.get("pages", db.pages.page_root_1_child_1_deep_1._id);

		expect(pageRoot1?.archiveOperationId).not.toBeUndefined();
		expect(pageRoot1Child1?.archiveOperationId).toBeUndefined();
		expect(pageRoot1Child1Deep1?.archiveOperationId).toBeUndefined();
		expect(pageRoot1Child1?.parentId).toBe(pages_ROOT_ID);
		expect(pageRoot1Child1?.path).toBe(`/${db.pages.page_root_1_child_1.name}`);
		expect(pageRoot1Child1Deep1?.parentId).toBe(db.pages.page_root_1_child_1._id);
		expect(pageRoot1Child1Deep1?.path).toBe(
			`/${db.pages.page_root_1_child_1.name}/${db.pages.page_root_1_child_1_deep_1.name}`,
		);
	});
});

test("resolve_page_id_from_path ignores archived pages with duplicate path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.ai_docs_temp.archive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_2._id],
	});

	const renameArchived = await asUser.mutation(api.ai_docs_temp.rename_page, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageId: db.pages.page_root_2._id,
		name: db.pages.page_root_1.name,
	});
	if (renameArchived._nay) {
		throw new Error("Expected archived rename to succeed");
	}

	const resolvedRoot1 = await t.run(async (ctx) =>
		ctx.runQuery(internal.ai_docs_temp.resolve_page_id_from_path, {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			path: `/${db.pages.page_root_1.name}`,
		}),
	);

	expect(resolvedRoot1).toBe(db.pages.page_root_1._id);
});

test("create_page_by_path reuses only active pages", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.ai_docs_temp.archive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_2._id],
	});

	const createByPath = await asUser.mutation(internal.ai_docs_temp.create_page_by_path, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		path: `/${db.pages.page_root_2.name}/new_leaf`,
		userId: String(db.pages.page_root_1.createdBy),
	});
	if (createByPath._nay) {
		throw new Error("Expected create_page_by_path to succeed with archived duplicate ancestor");
	}

	await t.run(async (ctx) => {
		const root2Path = `/${db.pages.page_root_2.name}`;
		const pagesAtRoot2Path = await ctx.db
			.query("pages")
			.withIndex("by_workspaceId_projectId_path_archiveOperationId", (q) =>
				q
					.eq("workspaceId", test_mocks_hardcoded.workspace_id.workspace_1)
					.eq("projectId", test_mocks_hardcoded.project_id.project_1)
					.eq("path", root2Path),
			)
			.collect();
		expect(pagesAtRoot2Path).toHaveLength(2);

		const activeRoot2 = pagesAtRoot2Path.find((page) => page.archiveOperationId === undefined);
		if (!activeRoot2) {
			throw new Error("Expected active root2 page to exist");
		}

		expect(activeRoot2._id).not.toBe(db.pages.page_root_2._id);

		const createdLeaf = await ctx.db.get("pages", createByPath._yay.pageId);
		expect(createdLeaf?.parentId).toBe(activeRoot2._id);
		expect(createdLeaf?.path).toBe(`/${db.pages.page_root_2.name}/new_leaf`);
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
	const stack = [{ parentId: startNodeId, absPath: basePath, cursor: null as string | null, depth: 0 }];

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

test("N07 rename_page idempotency: same name no-op", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	const before = await t.run(async (ctx) => ctx.db.get("pages", db.pages.page_root_1._id));

	const renameResult = await asUser.mutation(api.ai_docs_temp.rename_page, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageId: db.pages.page_root_1._id,
		name: db.pages.page_root_1.name,
	});
	expect(renameResult).not.toHaveProperty("_nay");

	const after = await t.run(async (ctx) => ctx.db.get("pages", db.pages.page_root_1._id));
	expect(after?.path).toBe(before?.path);
	expect(after?.name).toBe(before?.name);
});

test("N08 move_pages idempotency: same parent no-op", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	const before = await t.run(async (ctx) => ctx.db.get("pages", db.pages.page_root_1_child_1._id));

	const moveResult = await asUser.mutation(api.ai_docs_temp.move_pages, {
		itemIds: [db.pages.page_root_1_child_1._id],
		targetParentId: db.pages.page_root_1._id,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
	});
	expect(moveResult).not.toHaveProperty("_nay");

	const after = await t.run(async (ctx) => ctx.db.get("pages", db.pages.page_root_1_child_1._id));
	expect(after?.parentId).toBe(before?.parentId);
	expect(after?.path).toBe(before?.path);
});

test("N09 archive/unarchive idempotency", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.ai_docs_temp.archive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_2._id],
	});

	const archiveAgain = await asUser.mutation(api.ai_docs_temp.archive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_2._id],
	});
	expect(archiveAgain).not.toHaveProperty("_nay");

	const unarchiveResult = await asUser.mutation(api.ai_docs_temp.unarchive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_2._id],
	});
	expect(unarchiveResult).not.toHaveProperty("_nay");

	const unarchiveAgain = await asUser.mutation(api.ai_docs_temp.unarchive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_2._id],
	});
	expect(unarchiveAgain).not.toHaveProperty("_nay");

	await t.run(async (ctx) => {
		const p = await ctx.db.get("pages", db.pages.page_root_2._id);
		expect(p?.archiveOperationId).toBeUndefined();
	});
});

test("N02 archive child then parent then unarchive parent restores hierarchy", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.ai_docs_temp.archive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_1_child_1._id],
	});

	await asUser.mutation(api.ai_docs_temp.archive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_1._id],
	});

	await asUser.mutation(api.ai_docs_temp.unarchive_pages, {
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pageIds: [db.pages.page_root_1._id],
	});

	await t.run(async (ctx) => {
		const pageRoot1 = await ctx.db.get("pages", db.pages.page_root_1._id);
		const pageRoot1Child1 = await ctx.db.get("pages", db.pages.page_root_1_child_1._id);
		const pageRoot1Child1Deep1 = await ctx.db.get("pages", db.pages.page_root_1_child_1_deep_1._id);

		expect(pageRoot1?.archiveOperationId).toBeUndefined();
		expect(pageRoot1Child1?.archiveOperationId).toBeUndefined();
		expect(pageRoot1Child1Deep1?.archiveOperationId).toBeUndefined();
		expect(pageRoot1Child1?.parentId).toBe(pageRoot1?._id);
		expect(pageRoot1Child1Deep1?.parentId).toBe(pageRoot1Child1?._id);
	});
});
