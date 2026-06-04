import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi, type MockInstance } from "vitest";
import { encodeStateAsUpdate } from "yjs";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { math_clamp } from "../shared/shared-utils.ts";
import { minimatch } from "minimatch";
import { server_path_normalize } from "../server/server-utils.ts";
import {
	files_MAX_UPLOADS_BYTES,
	files_ROOT_ID,
	files_INITIAL_CONTENT,
	files_get_utf8_byte_size,
	files_u8_to_array_buffer,
	files_yjs_doc_create_from_markdown,
} from "../server/files.ts";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { billing_PRODUCTS } from "../shared/billing.ts";

let enqueueActionSpy: MockInstance;
let generateUploadUrlSpy: ReturnType<typeof vi.fn<(customKey?: string) => Promise<{ key: string; url: string }>>>;
const test = baseTest;

beforeEach(() => {
	// Keep file tests focused on file behavior; billing event enqueue behavior is
	// covered in billing tests.
	enqueueActionSpy = vi
		.spyOn(Workpool.prototype, "enqueueAction")
		.mockResolvedValue("work_file_test_billing_event" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	generateUploadUrlSpy = vi.fn(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(generateUploadUrlSpy);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function seed_billing_snapshot_for_user(ctx: MutationCtx, userId: Id<"users">) {
	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
	if (usageSnapshot) return;

	const polarProductId = "files_test_free_product";
	const existingProduct = await ctx.runQuery(components.polar.lib.getProduct, { id: polarProductId });
	if (!existingProduct) {
		await ctx.runMutation(components.polar.lib.createProduct, {
			product: {
				id: polarProductId,
				organizationId: "files_test_org",
				name: billing_PRODUCTS.Free.name,
				description: null,
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [
					{
						id: `${polarProductId}_price`,
						createdAt: "2026-01-01T00:00:00.000Z",
						modifiedAt: null,
						amountType: "free",
						isArchived: false,
						productId: polarProductId,
						priceCurrency: "eur",
						recurringInterval: "month",
					},
				],
				medias: [],
				benefits: [],
			},
		});
	}

	await ctx.db.insert("billing_usage_snapshots", {
		userId,
		polarCustomerId: `files_test_customer_${userId}`,
		subscription: {
			id: `files_test_subscription_${userId}`,
			productId: polarProductId,
			currency: "eur",
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		},
		meter: {
			id: "meter_press_usage",
			consumedUnits: 0,
			creditedUnits: 100_000,
			balance: 100_000,
			amountDueCents: 0,
		},
		lastSyncedAt: Date.now(),
	});
}

async function seed_file_first_list_fixture(ctx: MutationCtx) {
	const membership = await test_mocks_fill_db_with.membership(ctx);
	const fixtureFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: files_ROOT_ID,
		name: "fixture",
		kind: "folder",
		path: "/fixture",
		updatedAt: 1,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: fixtureFolderId,
		name: "00-source.md",
		kind: "file",
		path: "/fixture/00-source.md",
		updatedAt: 2,
	});
	const nestedFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: fixtureFolderId,
		name: "nested",
		kind: "folder",
		path: "/fixture/nested",
		updatedAt: 3,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: nestedFolderId,
		name: "glob-target.md",
		kind: "file",
		path: "/fixture/nested/glob-target.md",
		updatedAt: 4,
	});

	return membership;
}

async function seed_paginated_bash_listing_fixture(ctx: MutationCtx) {
	const membership = await test_mocks_fill_db_with.membership(ctx);
	const docsFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: files_ROOT_ID,
		name: "docs",
		kind: "folder",
		path: "/docs",
		updatedAt: 1,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "a.md",
		kind: "file",
		path: "/docs/a.md",
		updatedAt: 2,
		contentType: "text/markdown;charset=utf-8",
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "b.md",
		kind: "file",
		path: "/docs/b.md",
		updatedAt: 3,
	});
	const nestedFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "nested",
		kind: "folder",
		path: "/docs/nested",
		updatedAt: 4,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: nestedFolderId,
		name: "c.md",
		kind: "file",
		path: "/docs/nested/c.md",
		updatedAt: 5,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "z-archived.md",
		kind: "file",
		path: "/docs/z-archived.md",
		archiveOperationId: "archive-operation-test",
		updatedAt: 6,
	});
	const siblingPrefixFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: files_ROOT_ID,
		name: "docs-archive",
		kind: "folder",
		path: "/docs-archive",
		updatedAt: 7,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		workspaceId: membership.workspaceId,
		projectId: membership.projectId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: siblingPrefixFolderId,
		name: "outside.md",
		kind: "file",
		path: "/docs-archive/outside.md",
		updatedAt: 8,
	});

	return { ...membership, docsFolderId };
}

test("list_files", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const result_list_root = await list_dir({
		runQuery: asUser.query,
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		path: "/",
	});

	expect(result_list_root.items).toHaveLength(Object.keys(db.files).length);

	expect(result_list_root.items[0]).toStrictEqual({
		path: `/${db.files.file_root_1.name}`,
		updatedAt: db.files.file_root_1.updatedAt,
	});

	// The list must be depth-first
	expect(result_list_root.items[1]).toStrictEqual({
		path: `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}`,
		updatedAt: db.files.file_root_1_child_1.updatedAt,
	});
	expect(result_list_root.items[2]).toStrictEqual({
		path: `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}/${db.files.file_root_1_child_1_deep_1.name}`,
		updatedAt: db.files.file_root_1_child_1_deep_1.updatedAt,
	});

	const result_list_file_root_1 = await list_dir({
		runQuery: asUser.query,
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		path: `/${db.files.file_root_1.name}`,
	});

	expect(result_list_file_root_1.items).toHaveLength(
		[db.files.file_root_1_child_1, db.files.file_root_1_child_1_deep_1, db.files.file_root_1_child_2].length,
	);

	// The list must be depth-first
	expect(result_list_file_root_1.items[0]).toStrictEqual({
		path: `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}`,
		updatedAt: db.files.file_root_1_child_1.updatedAt,
	});
});

test("list_files_new", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const result_root = await asUser.query(internal.files_nodes.list_files, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		path: "/",
		maxDepth: 10,
		limit: 100,
	});

	expect(result_root.items).toHaveLength(Object.keys(db.files).length);

	expect(result_root.items[0], "The first result must be the first file at the root").toStrictEqual({
		path: `/${db.files.file_root_1.name}`,
		kind: "folder",
		updatedAt: db.files.file_root_1.updatedAt,
		depthTruncated: false,
	});

	expect(result_root.items[1], "The list must be depth-first").toStrictEqual({
		path: `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}`,
		kind: "folder",
		updatedAt: db.files.file_root_1_child_1.updatedAt,
		depthTruncated: false,
	});
	expect(result_root.items[2], "The list must be depth-first").toStrictEqual({
		path: `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}/${db.files.file_root_1_child_1_deep_1.name}`,
		kind: "folder",
		updatedAt: db.files.file_root_1_child_1_deep_1.updatedAt,
		depthTruncated: false,
	});

	expect(result_root.truncated).toBe(false);

	const result_under_root1 = await asUser.query(internal.files_nodes.list_files, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		path: `/${db.files.file_root_1.name}`,
		maxDepth: 10,
		limit: 100,
	});

	expect(result_under_root1.items).toHaveLength(
		[db.files.file_root_1_child_1, db.files.file_root_1_child_1_deep_1, db.files.file_root_1_child_2].length,
	);

	expect(result_under_root1.items[0], "The first result must be the first child of the root").toStrictEqual({
		path: `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}`,
		kind: "folder",
		updatedAt: db.files.file_root_1_child_1.updatedAt,
		depthTruncated: false,
	});

	// Depth truncation flagging: with maxDepth 1, the first child with deeper matches should be marked
	const result_depth1 = await asUser.query(internal.files_nodes.list_files, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		path: "/",
		maxDepth: 1,
		limit: 100,
	});

	expect(result_depth1.items[1]).toStrictEqual({
		path: `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}`,
		kind: "folder",
		updatedAt: db.files.file_root_1_child_1.updatedAt,
		depthTruncated: true,
	});
});

describe("list_files", () => {
	test("clamps high requested limits to the aggressive internal cap", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			for (let index = 0; index < 25; index++) {
				const name = `file-${String(index).padStart(2, "0")}.md`;
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
					createdBy: membership.userId,
					updatedBy: membership.userId,
					parentId: files_ROOT_ID,
					name,
					kind: "file",
					path: `/${name}`,
					updatedAt: index,
				});
			}
			return membership;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const result = await asUser.query(internal.files_nodes.list_files, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/",
			maxDepth: 10,
			limit: 100,
		});

		expect(result.items).toHaveLength(20);
		expect(result.items[0]?.path).toBe("/file-00.md");
		expect(result.items.at(-1)?.path).toBe("/file-19.md");
		expect(result.truncated).toBe(true);
	});

	test("continues sibling traversal after a file child", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_file_first_list_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const result = await asUser.query(internal.files_nodes.list_files, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/fixture",
			maxDepth: 10,
			limit: 10,
		});

		expect(result.truncated).toBe(false);
		expect(result.items.map((item) => item.path)).toEqual([
			"/fixture/00-source.md",
			"/fixture/nested",
			"/fixture/nested/glob-target.md",
		]);
	});

	test("finds include matches after non-matching file siblings", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_file_first_list_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const result = await asUser.query(internal.files_nodes.list_files, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/fixture",
			maxDepth: 10,
			limit: 10,
			include: "**/glob-target.md",
		});

		expect(result).toEqual({
			items: [
				{
					path: "/fixture/nested/glob-target.md",
					kind: "file",
					updatedAt: 4,
					depthTruncated: false,
				},
			],
			truncated: false,
		});
	});
});

describe("paginated bash listing queries", () => {
	test("paginates direct children without descendants or archived nodes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_dir_children_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/docs",
			numItems: 2,
			cursor: null,
		});
		const secondPage = await asUser.query(internal.files_nodes.list_dir_children_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/docs",
			numItems: 2,
			cursor: firstPage.continueCursor,
		});

		expect(firstPage.isDone).toBe(false);
		expect(firstPage.items.map((item) => item.name)).toEqual(["a.md", "b.md"]);
		expect(secondPage.items.map((item) => item.name)).toEqual(["nested"]);
		expect(secondPage.isDone).toBe(true);
		expect([...firstPage.items, ...secondPage.items].map((item) => item.path)).not.toContain("/docs/nested/c.md");
		expect([...firstPage.items, ...secondPage.items].map((item) => item.path)).not.toContain("/docs/z-archived.md");
	});

	test("paginates direct children by parent id in ascending and descending name order with metadata", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const ascending = await asUser.query(internal.files_nodes.list_dir_children_by_parent_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			order: "asc",
		});
		const descending = await asUser.query(internal.files_nodes.list_dir_children_by_parent_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			order: "desc",
		});

		expect(ascending.items.map((item) => item.name)).toEqual(["a.md", "b.md", "nested"]);
		expect(descending.items.map((item) => item.name)).toEqual(["nested", "b.md", "a.md"]);
		expect(ascending.items[0]).toMatchObject({
			name: "a.md",
			path: "/docs/a.md",
			kind: "file",
			updatedAt: 2,
			updatedBy: db.userId,
			contentType: "text/markdown;charset=utf-8",
		});
	});

	test("paginates recursive descendants by path prefix without sibling-prefix leakage", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_subtree_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/docs",
			numItems: 2,
			cursor: null,
		});
		const secondPage = await asUser.query(internal.files_nodes.list_subtree_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/docs",
			numItems: 10,
			cursor: firstPage.continueCursor,
		});
		const paths = [...firstPage.items, ...secondPage.items].map((item) => item.path);

		expect(firstPage.isDone).toBe(false);
		expect(new Set(paths).size).toBe(paths.length);
		expect(paths).toEqual(expect.arrayContaining(["/docs/a.md", "/docs/b.md", "/docs/nested", "/docs/nested/c.md"]));
		expect(paths).not.toContain("/docs/z-archived.md");
		expect(paths).not.toContain("/docs-archive");
		expect(paths).not.toContain("/docs-archive/outside.md");
	});

	test("paginates recursive descendants in ascending and descending path order with metadata", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const ascending = await asUser.query(internal.files_nodes.list_subtree_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/docs",
			numItems: 10,
			cursor: null,
			order: "asc",
		});
		const descending = await asUser.query(internal.files_nodes.list_subtree_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/docs",
			numItems: 10,
			cursor: null,
			order: "desc",
		});

		expect(ascending.items.map((item) => item.path)).toEqual(["/docs/a.md", "/docs/b.md", "/docs/nested", "/docs/nested/c.md"]);
		expect(descending.items.map((item) => item.path)).toEqual(["/docs/nested/c.md", "/docs/nested", "/docs/b.md", "/docs/a.md"]);
		expect(ascending.items[0]).toMatchObject({
			path: "/docs/a.md",
			kind: "file",
			updatedAt: 2,
			updatedBy: db.userId,
			contentType: "text/markdown;charset=utf-8",
		});
	});

	test("paginates raw path prefixes with intentional sibling-prefix matches", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const result = await asUser.query(internal.files_nodes.list_path_prefix_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			pathPrefix: "/docs",
			numItems: 20,
			cursor: null,
		});
		const paths = result.items.map((item) => item.path);

		expect(result.isDone).toBe(true);
		expect(paths).toEqual(
			expect.arrayContaining(["/docs", "/docs/a.md", "/docs/nested/c.md", "/docs-archive", "/docs-archive/outside.md"]),
		);
		expect(paths).not.toContain("/docs/z-archived.md");
	});

	test("returns a file start path exactly once for subtree pagination", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_subtree_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/docs/a.md",
			numItems: 1,
			cursor: null,
		});
		const secondPage = await asUser.query(internal.files_nodes.list_subtree_paginated, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/docs/a.md",
			numItems: 1,
			cursor: firstPage.continueCursor,
		});

		expect(firstPage.items.map((item) => item.path)).toEqual(["/docs/a.md"]);
		expect(firstPage.isDone).toBe(true);
		expect(secondPage.items).toEqual([]);
		expect(secondPage.isDone).toBe(true);
	});
});

test("generated sibling file is visible in tree and list queries", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const { sourceNodeId, markdownNodeId } = await t.run(async (ctx) => {
		const sharedNode = {
			...test_mocks.files.base(),
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			kind: "file" as const,
		};
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf",
			path: "/report.pdf",
		});
		const markdownNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf.md",
			path: "/report.pdf.md",
		});

		return { sourceNodeId, markdownNodeId };
	});

	const [treeNodesList, filesList] = await Promise.all([
		asUser.query(api.files_nodes.get_file_nodes_list, {
			membershipId: db.membershipId,
		}),
		asUser.query(internal.files_nodes.list_files, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: "/",
			maxDepth: 10,
			limit: 100,
		}),
	]);

	const treeNodeIds = treeNodesList.map((node) => node._id);
	expect(treeNodeIds).toContain(sourceNodeId);
	expect(treeNodeIds).toContain(markdownNodeId);
	expect(filesList.items.map((item) => item.path)).toEqual(expect.arrayContaining(["/report.pdf", "/report.pdf.md"]));
});

test("get_by_path uses materialized paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const root1Path = `/${db.files.file_root_1.name}`;
	const child1Path = `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}`;
	const deep1Path = `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}/${db.files.file_root_1_child_1_deep_1.name}`;

	const [root1, child1, deep1] = await Promise.all([
		asUser.query(internal.files_nodes.get_by_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: root1Path,
		}),
		asUser.query(internal.files_nodes.get_by_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: child1Path,
		}),
		asUser.query(internal.files_nodes.get_by_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: deep1Path,
		}),
	]);

	expect(root1?._id).toBe(db.files.file_root_1._id);
	expect(child1?._id).toBe(db.files.file_root_1_child_1._id);
	expect(deep1?._id).toBe(db.files.file_root_1_child_1_deep_1._id);
});

test("rename_node updates descendants materialized paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const renamedRootName = "renamed_root";
	await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		name: renamedRootName,
	});

	await t.run(async (ctx) => {
		const [renamedRoot, renamedChild, renamedDeep] = await Promise.all([
			ctx.db.get("files_nodes", db.files.file_root_1._id),
			ctx.db.get("files_nodes", db.files.file_root_1_child_1._id),
			ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id),
		]);

		expect(renamedRoot?.path).toBe(`/${renamedRootName}`);
		expect(renamedChild?.path).toBe(`/${renamedRootName}/${db.files.file_root_1_child_1.name}`);
		expect(renamedDeep?.path).toBe(
			`/${renamedRootName}/${db.files.file_root_1_child_1.name}/${db.files.file_root_1_child_1_deep_1.name}`,
		);
	});
});

test("rename_node leaves generated siblings independent from the source", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const { sourceNodeId, generatedNodeId } = await t.run(async (ctx) => {
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			name: "report.pdf",
			kind: "file",
			path: "/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			name: "report.pdf.md",
			kind: "file",
			path: "/report.pdf.md",
		});

		return { sourceNodeId, generatedNodeId };
	});

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: sourceNodeId,
		name: "renamed.pdf",
	});
	if (renameResult._nay) {
		throw new Error("Expected source rename with generated sibling to succeed", {
			cause: renameResult._nay,
		});
	}

	const docs = await t.run(async (ctx) => {
		const source = await ctx.db.get("files_nodes", sourceNodeId);
		const generated = await ctx.db.get("files_nodes", generatedNodeId);
		return { source, generated };
	});
	expect(docs.source?.path).toBe("/renamed.pdf");
	expect(docs.generated).toMatchObject({
		parentId: files_ROOT_ID,
		name: "report.pdf.md",
		path: "/report.pdf.md",
	});
});

test("move_nodes updates descendants materialized paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.files_nodes.move_nodes, {
		itemIds: [db.files.file_root_1_child_1._id],
		targetParentId: db.files.file_root_2._id,
		membershipId: db.membershipId,
	});

	await t.run(async (ctx) => {
		const [movedChild, movedDeep] = await Promise.all([
			ctx.db.get("files_nodes", db.files.file_root_1_child_1._id),
			ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id),
		]);

		expect(movedChild?.path).toBe(`/${db.files.file_root_2.name}/${db.files.file_root_1_child_1.name}`);
		expect(movedDeep?.path).toBe(
			`/${db.files.file_root_2.name}/${db.files.file_root_1_child_1.name}/${db.files.file_root_1_child_1_deep_1.name}`,
		);
	});
});

test("move_nodes leaves generated siblings independent from the source", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const targetFolder = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "received",
	});
	if (targetFolder._nay) {
		throw new Error(targetFolder._nay.message);
	}
	const { sourceNodeId, generatedNodeId } = await t.run(async (ctx) => {
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "report.pdf",
			kind: "file",
			path: "/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "report.pdf.md",
			kind: "file",
			path: "/report.pdf.md",
		});

		return { sourceNodeId, generatedNodeId };
	});

	const moveResult = await asUser.mutation(api.files_nodes.move_nodes, {
		membershipId: db.membershipId,
		itemIds: [sourceNodeId],
		targetParentId: targetFolder._yay.nodeId,
	});
	if (moveResult._nay) {
		throw new Error("Expected source move with generated sibling to succeed", {
			cause: moveResult._nay,
		});
	}

	const docs = await t.run(async (ctx) => {
		const source = await ctx.db.get("files_nodes", sourceNodeId);
		const generated = await ctx.db.get("files_nodes", generatedNodeId);
		return { source, generated };
	});
	expect(docs.source?.path).toBe("/received/report.pdf");
	expect(docs.generated).toMatchObject({
		parentId: files_ROOT_ID,
		name: "report.pdf.md",
		path: "/report.pdf.md",
	});
});

test("home file path stays immutable on rename and move", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const homeNodeId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedAt: Date.now(),
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "README.md",
			kind: "file",
			path: "/README.md",
			archiveOperationId: undefined,
		}),
	);

	await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: homeNodeId,
		name: "renamed-home.md",
	});

	await asUser.mutation(api.files_nodes.move_nodes, {
		itemIds: [homeNodeId],
		targetParentId: db.files.file_root_1._id,
		membershipId: db.membershipId,
	});

	await t.run(async (ctx) => {
		const homeFile = await ctx.db.get("files_nodes", homeNodeId);
		expect(homeFile?.name).toBe("README.md");
		expect(homeFile?.path).toBe("/README.md");
		expect(homeFile?.parentId).toBe(files_ROOT_ID);
	});
});

test("create_folder_node rejects duplicate active path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const duplicateCreation = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: files_ROOT_ID,
		name: db.files.file_root_1.name,
		membershipId: db.membershipId,
	});

	if (duplicateCreation._yay) {
		throw new Error("Expected duplicate creation to fail");
	}

	expect(duplicateCreation._nay.message).toBe("This folder already exists.");
});

test("create_folder_node rejects active file at leaf path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "notes",
			kind: "file",
			path: "/notes",
		}),
	);

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "notes",
	});

	if (result._yay) {
		throw new Error("Expected folder creation to fail when a file already owns the path");
	}
	expect(result._nay.message).toBe("This folder already exists.");
});

test("create_folder_node rejects active file at intermediate path without creating descendants", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const fileNodeId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "notes",
			kind: "file",
			path: "/notes",
		}),
	);

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "notes/child",
	});

	if (result._yay) {
		throw new Error("Expected folder creation to fail when an intermediate path is a file");
	}
	expect(result._nay.message).toBe("This folder already exists.");

	await t.run(async (ctx) => {
		const existingFile = await ctx.db.get("files_nodes", fileNodeId);
		const child = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q
					.eq("workspaceId", db.workspaceId)
					.eq("projectId", db.projectId)
					.eq("path", "/notes/child")
					.eq("archiveOperationId", undefined),
			)
			.first();

		expect(existingFile?.kind).toBe("file");
		expect(child).toBeNull();
	});
});

test("create_folder_node reuses active intermediate folders", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: `${db.files.file_root_1.name}/new-child`,
	});

	if (result._nay) {
		throw new Error("Expected create_folder_node to reuse the existing intermediate folder", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const folder = await ctx.db.get("files_nodes", result._yay.nodeId);
		const rootFolders = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_parent_name_archiveOperation", (q) =>
				q
					.eq("workspaceId", db.workspaceId)
					.eq("projectId", db.projectId)
					.eq("parentId", files_ROOT_ID)
					.eq("name", db.files.file_root_1.name)
					.eq("archiveOperationId", undefined),
			)
			.collect()
			.then((nodes) => nodes.filter((node) => node.kind === "folder"));

		expect(folder).toMatchObject({
			name: "new-child",
			path: `/${db.files.file_root_1.name}/new-child`,
			parentId: db.files.file_root_1._id,
			kind: "folder",
		});
		expect(rootFolders).toHaveLength(1);
		expect(rootFolders[0]?._id).toBe(db.files.file_root_1._id);
	});
});

test("create_markdown_node preserves caller-provided file names", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "extensionless-create-file",
	});
	if (createdFile._nay) {
		throw new Error("Expected create_markdown_node to preserve caller-provided file name", {
			cause: createdFile._nay,
		});
	}

	await t.run(async (ctx) => {
		const file = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		expect(file?.name).toBe("extensionless-create-file");
		expect(file?.path).toBe("/extensionless-create-file");
	});
});

test("create_markdown_node stores Markdown file properties", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "properties.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		const asset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
		return { node, asset };
	});
	expect(saved.node).toMatchObject({
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		contentType: "text/markdown;charset=utf-8",
		assetId: saved.asset?._id,
	});
	expect(saved.asset).toMatchObject({
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		kind: "content",
		r2Bucket: "test-files-bucket",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.asset?.r2Key).toBe(`workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${saved.asset?._id}`);
});

test("create_markdown_node seeds initial Yjs content on the server", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial Content User",
	});

	const createdFile = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "server-initial.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!node?.assetId || !node.yjsLastSequenceId || !node.yjsSnapshotId) {
			throw new Error("Expected server-seeded Markdown node docs");
		}

		const [asset, lastSequence, yjsSnapshot, yjsUpdates] = await Promise.all([
			ctx.db.get("files_r2_assets", node.assetId),
			ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId),
			ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId),
			ctx.db
				.query("files_yjs_updates")
				.withIndex("by_workspace_project_file_sequence", (q) =>
					q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", createdFile._yay.nodeId),
				)
				.order("asc")
				.collect(),
		]);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;

		return { node, asset, lastSequence, yjsSnapshot, yjsSnapshotAsset, yjsUpdates };
	});

	expect(saved.node.contentType).toBe("text/markdown;charset=utf-8");
	expect(saved.asset).toMatchObject({
		kind: "content",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.lastSequence?.lastSequence).toBe(0);
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		kind: "yjs_snapshot",
	});
	expect(saved.yjsUpdates).toHaveLength(0);
});

test("create_markdown_node writes server-seeded initial content to R2", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial Materialize User",
		email: "initial-materialize-user@example.com",
	});
	const r2Writes = new Map<string, BodyInit>();
	generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return {
			key,
			url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
		};
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload") && init?.method === "PUT") {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				r2Writes.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			if (urlString.startsWith("https://r2.test/object?key=")) {
				const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
				const body = r2Writes.get(key);
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
			}

			return new Response(null, { status: 404 });
		}),
	);

	const createdFile = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "server-initial-materialized.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!node?.assetId || !node.yjsSnapshotId) {
			throw new Error("Expected materialized server-seeded file docs");
		}

		const asset = await ctx.db.get("files_r2_assets", node.assetId);
		const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", createdFile._yay.nodeId),
			)
			.collect();
		const versionSnapshot = await ctx.db
			.query("files_snapshots")
			.withIndex("by_workspace_project_file_archivedAt", (q) =>
				q
					.eq("workspaceId", db.workspaceId)
					.eq("projectId", db.projectId)
					.eq("nodeId", createdFile._yay.nodeId)
					.eq("archivedAt", -1),
			)
			.first();
		const versionSnapshotAsset = versionSnapshot?.assetId
			? await ctx.db.get("files_r2_assets", versionSnapshot.assetId)
			: null;

		return {
			asset,
			yjsSnapshot,
			yjsSnapshotAsset,
			yjsUpdates,
			versionSnapshot,
			versionSnapshotAsset,
		};
	});

	expect(saved.asset).toMatchObject({
		r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${saved.asset?._id}`,
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${saved.yjsSnapshotAsset?._id}`,
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.versionSnapshot?.nodeId).toBe(createdFile._yay.nodeId);
	expect(saved.versionSnapshotAsset).toMatchObject({
		r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${saved.versionSnapshotAsset?._id}`,
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(r2Writes.get(saved.asset!.r2Key!)).toBe(files_INITIAL_CONTENT);
	expect(r2Writes.get(saved.versionSnapshotAsset!.r2Key!)).toBe(files_INITIAL_CONTENT);
	expect(r2Writes.has(saved.yjsSnapshotAsset!.r2Key!)).toBe(true);
});

test("create_folder_node creates missing folders for nested folder paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});
	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: files_ROOT_ID,
		name: "invalid/name",
		membershipId: db.membershipId,
	});

	if (result._nay) {
		throw new Error("Expected create_folder_node to create the nested folder path", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const folder = await ctx.db.get("files_nodes", result._yay.nodeId);
		expect(folder?.name).toBe("name");
		expect(folder?.path).toBe("/invalid/name");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("path", "/invalid"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(folder?.parentId).toBe(parentFolder?._id);
	});
});

test("create_markdown_node creates missing folders for nested file paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const result = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "notes/projects/plan.md",
	});
	if (result._nay) {
		throw new Error("Expected create_markdown_node to create the nested file path", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const file = await ctx.db.get("files_nodes", result._yay.nodeId);
		expect(file?.name).toBe("plan.md");
		expect(file?.path).toBe("/notes/projects/plan.md");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("path", "/notes/projects"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(file?.parentId).toBe(parentFolder?._id);
	});
});

test("archived nodes can share path with a new active node", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});
	const duplicateName = "archived-duplicate-allowed.md";

	const createdFile = await asUser.action(internal.files_nodes.create_file_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path: `/${duplicateName}`,
	});
	if (createdFile._nay) {
		throw new Error("Expected initial file creation to succeed");
	}

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [createdFile._yay.nodeId],
	});

	const recreatedFile = await asUser.action(api.files_nodes.create_markdown_node, {
		parentId: files_ROOT_ID,
		name: duplicateName,
		membershipId: db.membershipId,
	});
	if (recreatedFile._nay) {
		throw new Error("Expected recreated file creation to succeed");
	}

	await t.run(async (ctx) => {
		const path = `/${duplicateName}`;
		const filesAtPath = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("path", path),
			)
			.collect();

		expect(filesAtPath).toHaveLength(2);
		expect(filesAtPath.filter((file) => file.archiveOperationId !== undefined)).toHaveLength(1);
		expect(filesAtPath.filter((file) => file.archiveOperationId === undefined)).toHaveLength(1);
	});
});

test("create_file_by_path can reuse an existing active file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});
	const path = "/existing-by-path.md";

	const createdFile = await asUser.action(internal.files_nodes.create_file_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path,
	});
	if (createdFile._nay) {
		throw new Error("Expected initial file creation to succeed");
	}

	const reusedFile = await asUser.action(internal.files_nodes.create_file_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path,
	});
	if (reusedFile._nay) {
		throw new Error("Expected existing file reuse to succeed");
	}

	expect(reusedFile._yay.nodeId).toBe(createdFile._yay.nodeId);
});

describe("files_nodes.get_authorized_by_path", () => {
	test("returns active nodes by path and ignores archived nodes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.action(api.files_nodes.create_markdown_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "lookup.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const active = await asUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: db.membershipId,
			path: "/lookup.md",
		});
		expect(active).toEqual({
			nodeId: created._yay.nodeId,
			name: "lookup.md",
			kind: "file",
			assetId: expect.any(String),
		});

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [created._yay.nodeId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}

		const missing = await asUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: db.membershipId,
			path: "/lookup.md",
		});
		expect(missing).toBeNull();
	});
});

describe("files_nodes.create_upload_node", () => {
	test("creates a visible R2 node and uses its id in the R2 key", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "annual-report.pdf",
			contentType: "application/pdf",
			size: 1234,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}

		expect(upload._yay).toMatchObject({
			url: "https://r2.test/upload",
			headers: { "Content-Type": "application/pdf" },
		});

		const docs = await t.run(async (ctx) => {
			const source = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			return { asset, source };
		});
		expect(docs.source).toMatchObject({
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			parentId: files_ROOT_ID,
			name: "annual-report.pdf",
			kind: "file",
			contentType: "application/pdf",
			assetId: upload._yay.assetId,
		});
		expect(docs.source?.archiveOperationId).toBeUndefined();
		expect(docs.asset).toMatchObject({
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			kind: "upload",
			createdBy: db.userId,
			r2Bucket: "test-files-bucket",
			size: 1234,
		});
		expect(docs.asset?.r2Key).toBeUndefined();
		expect(generateUploadUrlSpy).toHaveBeenCalledWith(
			`workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${upload._yay.assetId}`,
		);
	});

	test("rejects folder path conflicts before creating a source file node or upload doc", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const existing = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: "annual-report.pdf",
		});
		if (existing._nay) {
			throw new Error(existing._nay.message);
		}

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "annual-report.pdf",
			contentType: "application/pdf",
			size: 1234,
		});

		expect(upload._nay).toMatchObject({ message: "The path cannot point to a folder" });
		const docs = await t.run(async (ctx) => {
			const uploadAssets = await ctx.db
				.query("files_r2_assets")
				.collect()
				.then((assets) =>
					assets.filter(
						(asset) =>
							asset.workspaceId === db.workspaceId && asset.projectId === db.projectId && asset.kind === "upload",
					),
				);
			const uploadedSources = await ctx.db
				.query("files_nodes")
				.collect()
				.then((nodes) =>
					nodes.filter(
						(node) => node.workspaceId === db.workspaceId && node.projectId === db.projectId && node.assetId,
					),
				);
			return { uploadAssets, uploadedSources };
		});
		expect(docs.uploadAssets).toHaveLength(0);
		expect(docs.uploadedSources).toHaveLength(0);
	});

	test("rejects oversized uploads before creating a visible node", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "too-large.pdf",
			contentType: "application/pdf",
			size: files_MAX_UPLOADS_BYTES + 1,
		});

		expect(upload._nay).toMatchObject({ message: "File too large" });
		const uploadedSources = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.collect()
				.then((nodes) =>
					nodes.filter(
						(node) => node.workspaceId === db.workspaceId && node.projectId === db.projectId && node.assetId,
					),
				),
		);
		expect(uploadedSources).toHaveLength(0);
	});

	test("replace archives only the conflicting upload source", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const oldUpload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "replace-me.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (oldUpload._nay) {
			throw new Error(oldUpload._nay.message);
		}
		const generatedNodeId = await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				kind: "content",
				r2Bucket: "test-files-bucket",
				r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/generated-test-asset`,
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			return await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "replace-me.pdf.md",
				kind: "file",
				path: "/replace-me.pdf.md",
				contentType: "text/markdown;charset=utf-8",
				assetId,
			});
		});

		const replacement = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "replace-me.pdf",
			contentType: "application/pdf",
			size: 2048,
		});
		if (replacement._nay) {
			throw new Error(replacement._nay.message);
		}

		const docs = await t.run(async (ctx) => {
			const oldSource = await ctx.db.get("files_nodes", oldUpload._yay.nodeId);
			const generated = await ctx.db.get("files_nodes", generatedNodeId);
			const newSource = await ctx.db.get("files_nodes", replacement._yay.nodeId);
			const newAsset = await ctx.db.get("files_r2_assets", replacement._yay.assetId);
			return { oldSource, generated, newSource, newAsset };
		});
		expect(docs.oldSource?.archiveOperationId).toEqual(expect.any(String));
		expect(docs.generated).toMatchObject({
			name: "replace-me.pdf.md",
			path: "/replace-me.pdf.md",
		});
		expect(docs.generated?.archiveOperationId).toBeUndefined();
		expect(docs.newSource).toMatchObject({
			name: "replace-me.pdf",
			assetId: replacement._yay.assetId,
		});
		expect(docs.newSource?.archiveOperationId).toBeUndefined();
		expect(docs.newAsset).toMatchObject({
			kind: "upload",
			size: 2048,
		});
		expect(generateUploadUrlSpy).toHaveBeenCalledWith(
			`workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${replacement._yay.assetId}`,
		);
	});
});

test("rename_node returns conflict and keeps original path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_2._id,
		name: db.files.file_root_1.name,
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
		const fileRoot2 = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(fileRoot2?.name).toBe(db.files.file_root_2.name);
		expect(fileRoot2?.path).toBe(`/${db.files.file_root_2.name}`);
	});
});

test("rename_node preserves caller-provided file names", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "rename-source.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected source file creation to succeed", {
			cause: createdFile._nay,
		});
	}

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		name: "renamed-extensionless",
	});
	if (renameResult._nay) {
		throw new Error("Expected rename_node to preserve caller-provided file name", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const file = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		expect(file?.name).toBe("renamed-extensionless");
		expect(file?.path).toBe("/renamed-extensionless");
	});
});

test("rename_node creates missing folders for nested file paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "rename-path-source.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected source file creation to succeed", {
			cause: createdFile._nay,
		});
	}

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		name: "notes/projects/plan.md",
	});
	if (renameResult._nay) {
		throw new Error("Expected rename_node to create the nested file path", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const file = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		expect(file?.name).toBe("plan.md");
		expect(file?.path).toBe("/notes/projects/plan.md");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("path", "/notes/projects"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(file?.parentId).toBe(parentFolder?._id);
	});
});

test("rename_node preserves caller-provided nested file names", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const nestedFileId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedAt: Date.now(),
			updatedBy: db.userId,
			parentId: db.files.file_root_1._id,
			name: "yo.md",
			kind: "file",
			path: `/${db.files.file_root_1.name}/yo.md`,
			archiveOperationId: undefined,
		}),
	);

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: nestedFileId,
		name: "README",
	});
	if (renameResult._nay) {
		throw new Error("Expected rename_node to preserve nested README file name", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const file = await ctx.db.get("files_nodes", nestedFileId);
		expect(file?.name).toBe("README");
		expect(file?.path).toBe(`/${db.files.file_root_1.name}/README`);
	});
});

test("rename_node preserves caller-provided file extensions", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "unsupported-source.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected source file creation to succeed", {
			cause: createdFile._nay,
		});
	}

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		name: "renamed-source.txt",
	});

	if (renameResult._nay) {
		throw new Error("Expected rename_node to preserve caller-provided file extension", {
			cause: renameResult._nay,
		});
	}

	const after = await t.run(async (ctx) => ctx.db.get("files_nodes", createdFile._yay.nodeId));
	expect(after?.name).toBe("renamed-source.txt");
	expect(after?.path).toBe("/renamed-source.txt");
});

test("rename_node creates missing folders for nested folder paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_2._id,
		name: "invalid/name",
	});

	if (renameResult._nay) {
		throw new Error("Expected rename_node to create the nested folder path", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const folder = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(folder?.name).toBe("name");
		expect(folder?.path).toBe("/invalid/name");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("path", "/invalid"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(folder?.parentId).toBe(parentFolder?._id);
	});
});

test("move_nodes returns conflict and keeps original path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const conflictingSibling = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: db.files.file_root_2._id,
		name: db.files.file_root_1_child_1.name,
		membershipId: db.membershipId,
	});
	if (conflictingSibling._nay) {
		throw new Error("Expected conflicting sibling creation to succeed");
	}

	const moveResult = await asUser.mutation(api.files_nodes.move_nodes, {
		itemIds: [db.files.file_root_1_child_1._id],
		targetParentId: db.files.file_root_2._id,
		membershipId: db.membershipId,
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
		const child1 = await ctx.db.get("files_nodes", db.files.file_root_1_child_1._id);
		expect(child1?.parentId).toBe(db.files.file_root_1._id);
		expect(child1?.path).toBe(`/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}`);
	});
});

test("unarchive_nodes returns conflict when active file already has the same path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	await t.run(async (ctx) =>
		ctx.db.patch("files_nodes", db.files.file_root_2._id, {
			archiveOperationId: "unarchive-conflict-test",
			name: db.files.file_root_1.name,
			path: `/${db.files.file_root_1.name}`,
		}),
	);

	const unarchiveResult = await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
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
		const fileRoot2 = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(fileRoot2?.archiveOperationId).not.toBeUndefined();
	});
});

test("archive_nodes and unarchive_nodes leave root generated siblings independent from the source", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const { sourceNodeId, generatedNodeId } = await t.run(async (ctx) => {
		const sharedNode = {
			...test_mocks.files.base(),
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			kind: "file" as const,
		};
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf",
			path: "/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf.md",
			path: "/report.pdf.md",
		});

		return { sourceNodeId, generatedNodeId };
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [sourceNodeId],
	});

	const archivedDocs = await t.run(async (ctx) => {
		const source = await ctx.db.get("files_nodes", sourceNodeId);
		const generated = await ctx.db.get("files_nodes", generatedNodeId);
		return { source, generated };
	});
	expect(archivedDocs.source?.archiveOperationId).toEqual(expect.any(String));
	expect(archivedDocs.generated?.archiveOperationId).toBeUndefined();

	await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [sourceNodeId],
	});

	const unarchivedDocs = await t.run(async (ctx) => {
		const source = await ctx.db.get("files_nodes", sourceNodeId);
		const generated = await ctx.db.get("files_nodes", generatedNodeId);
		return { source, generated };
	});
	expect(unarchivedDocs.source?.archiveOperationId).toBeUndefined();
	expect(unarchivedDocs.generated?.archiveOperationId).toBeUndefined();
});

test("archive_nodes and unarchive_nodes include generated siblings as normal folder descendants", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const { folderId, sourceNodeId, generatedNodeId } = await t.run(async (ctx) => {
		const folderId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "folder",
			kind: "folder",
			path: "/folder",
		});
		const sharedNode = {
			...test_mocks.files.base(),
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: folderId,
			kind: "file" as const,
		};
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf",
			path: "/folder/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf.md",
			path: "/folder/report.pdf.md",
		});

		return { folderId, sourceNodeId, generatedNodeId };
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [folderId],
	});

	const archivedDocs = await t.run(async (ctx) => {
		const folder = await ctx.db.get("files_nodes", folderId);
		const source = await ctx.db.get("files_nodes", sourceNodeId);
		const generated = await ctx.db.get("files_nodes", generatedNodeId);
		return { folder, source, generated };
	});
	expect(archivedDocs.folder?.archiveOperationId).toEqual(expect.any(String));
	expect(archivedDocs.source?.archiveOperationId).toBe(archivedDocs.folder?.archiveOperationId);
	expect(archivedDocs.generated?.archiveOperationId).toBe(archivedDocs.folder?.archiveOperationId);

	await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [folderId],
	});

	const unarchivedDocs = await t.run(async (ctx) => {
		const folder = await ctx.db.get("files_nodes", folderId);
		const source = await ctx.db.get("files_nodes", sourceNodeId);
		const generated = await ctx.db.get("files_nodes", generatedNodeId);
		return { folder, source, generated };
	});
	expect(unarchivedDocs.folder?.archiveOperationId).toBeUndefined();
	expect(unarchivedDocs.source?.archiveOperationId).toBeUndefined();
	expect(unarchivedDocs.generated?.archiveOperationId).toBeUndefined();
});

test("unarchive_nodes excludes unrequested ancestors from Archive Operation", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_1._id],
	});

	const unarchiveResult = await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_1_child_1._id],
	});
	if (unarchiveResult._nay) {
		throw new Error("Expected unarchive of child subtree to succeed");
	}

	await t.run(async (ctx) => {
		const fileRoot1 = await ctx.db.get("files_nodes", db.files.file_root_1._id);
		const fileRoot1Child1 = await ctx.db.get("files_nodes", db.files.file_root_1_child_1._id);
		const fileRoot1Child1Deep1 = await ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id);

		expect(fileRoot1?.archiveOperationId).not.toBeUndefined();
		expect(fileRoot1Child1?.archiveOperationId).toBeUndefined();
		expect(fileRoot1Child1Deep1?.archiveOperationId).toBeUndefined();
		expect(fileRoot1Child1?.parentId).toBe(files_ROOT_ID);
		expect(fileRoot1Child1?.path).toBe(`/${db.files.file_root_1_child_1.name}`);
		expect(fileRoot1Child1Deep1?.parentId).toBe(db.files.file_root_1_child_1._id);
		expect(fileRoot1Child1Deep1?.path).toBe(
			`/${db.files.file_root_1_child_1.name}/${db.files.file_root_1_child_1_deep_1.name}`,
		);
	});
});

test("get_by_path ignores archived files with duplicate path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});

	const renameArchived = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_2._id,
		name: db.files.file_root_1.name,
	});
	if (renameArchived._nay) {
		throw new Error("Expected archived rename to succeed");
	}

	const resolvedRoot1 = await asUser.query(internal.files_nodes.get_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		path: `/${db.files.file_root_1.name}`,
	});

	expect(resolvedRoot1?._id).toBe(db.files.file_root_1._id);
});

test("create_file_by_path creates active ancestors instead of reusing archived nodes", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});

	const createByPath = await asUser.action(internal.files_nodes.create_file_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path: `/${db.files.file_root_2.name}/new-leaf.md`,
	});
	if (createByPath._nay) {
		throw new Error("Expected create_file_by_path to succeed with archived duplicate ancestor");
	}

	await t.run(async (ctx) => {
		const root2Path = `/${db.files.file_root_2.name}`;
		const filesAtRoot2Path = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("path", root2Path),
			)
			.collect();
		expect(filesAtRoot2Path).toHaveLength(2);

		const activeRoot2 = filesAtRoot2Path.find((file) => file.archiveOperationId === undefined);
		if (!activeRoot2) {
			throw new Error("Expected active root2 file to exist");
		}

		expect(activeRoot2._id).not.toBe(db.files.file_root_2._id);

		const createdLeaf = await ctx.db.get("files_nodes", createByPath._yay.nodeId);
		expect(createdLeaf?.parentId).toBe(activeRoot2._id);
		expect(createdLeaf?.path).toBe(`/${db.files.file_root_2.name}/new-leaf.md`);
	});
});

async function list_dir(args: {
	runQuery: (ref: any, args: any) => Promise<any>;
	workspaceId: string;
	projectId: string;
	path: string;
	maxDepth?: number;
	limit?: number;
	include?: string;
}): Promise<{ items: Array<{ path: string; updatedAt: number }>; metadata: { count: number; truncated: boolean } }> {
	// Resolve the starting node id for the provided path
	const startNodeId = await args.runQuery(internal.files_nodes.resolve_tree_node_id_from_path, {
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

		const paginatedResult = await args.runQuery(internal.files_nodes.get_file_info_for_list_dir_pagination, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: frame.parentId,
			cursor: frame.cursor,
		});

		// No more children at this cursor for this parent or file is empty
		if (paginatedResult.isDone) continue;

		const child = paginatedResult.files.at(0);
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
			stack.push({ parentId: child.nodeId, absPath: childPath, cursor: null, depth: nextDepth });
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

test("N07 rename_node idempotency: same name no-op", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const before = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1._id));

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		name: db.files.file_root_1.name,
	});
	expect(renameResult).not.toHaveProperty("_nay");

	const after = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1._id));
	expect(after?.path).toBe(before?.path);
	expect(after?.name).toBe(before?.name);
});

test("N08 move_nodes idempotency: same parent no-op", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const before = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1_child_1._id));

	const moveResult = await asUser.mutation(api.files_nodes.move_nodes, {
		itemIds: [db.files.file_root_1_child_1._id],
		targetParentId: db.files.file_root_1._id,
		membershipId: db.membershipId,
	});
	expect(moveResult).not.toHaveProperty("_nay");

	const after = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1_child_1._id));
	expect(after?.parentId).toBe(before?.parentId);
	expect(after?.path).toBe(before?.path);
});

test("N09 archive idempotency", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	await t.run(async (ctx) =>
		ctx.db.patch("files_nodes", db.files.file_root_2._id, {
			archiveOperationId: "archive-idempotency-test",
		}),
	);

	const archiveAgain = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});
	expect(archiveAgain).not.toHaveProperty("_nay");

	await t.run(async (ctx) => {
		const p = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(p?.archiveOperationId).toBe("archive-idempotency-test");
	});
});

test("N09 unarchive idempotency", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const unarchiveAgain = await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});
	expect(unarchiveAgain).not.toHaveProperty("_nay");

	await t.run(async (ctx) => {
		const p = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(p?.archiveOperationId).toBeUndefined();
	});
});

test("N02 archive child then parent then unarchive parent restores hierarchy", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	// Seed the pre-archived child subtree so this test spends rate-limit writes
	// on the parent archive and unarchive behavior under test.
	await t.run(async (ctx) => {
		const childArchiveOperationId = "test_child_archive_operation";
		await Promise.all([
			ctx.db.patch("files_nodes", db.files.file_root_1_child_1._id, {
				archiveOperationId: childArchiveOperationId,
			}),
			ctx.db.patch("files_nodes", db.files.file_root_1_child_1_deep_1._id, {
				archiveOperationId: childArchiveOperationId,
			}),
		]);
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_1._id],
	});

	await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_1._id],
	});

	await t.run(async (ctx) => {
		const fileRoot1 = await ctx.db.get("files_nodes", db.files.file_root_1._id);
		const fileRoot1Child1 = await ctx.db.get("files_nodes", db.files.file_root_1_child_1._id);
		const fileRoot1Child1Deep1 = await ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id);

		expect(fileRoot1?.archiveOperationId).toBeUndefined();
		expect(fileRoot1Child1?.archiveOperationId).toBeUndefined();
		expect(fileRoot1Child1Deep1?.archiveOperationId).toBeUndefined();
		expect(fileRoot1Child1?.parentId).toBe(fileRoot1?._id);
		expect(fileRoot1Child1Deep1?.parentId).toBe(fileRoot1Child1?._id);
	});
});

test("membership-scoped file and yjs APIs reject cross-user membership ids", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const ownerIdentity = {
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Owner User",
	};
	const asOwner = t.withIdentity(ownerIdentity);

	const otherUserId = await t.run(async (ctx) =>
		ctx.db.insert("users", {
			clerkUserId: null,
		}),
	);
	const asOtherUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: otherUserId,
		name: "Other User",
	});

	const unauthorizedRename = await asOtherUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		name: "should-not-rename",
	});
	if (!unauthorizedRename._nay) {
		throw new Error("Expected rename_node to reject cross-user membership access");
	}
	expect(unauthorizedRename._nay.message).toBe("Unauthorized");

	const createdFile = await asOwner.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "membership-yjs-regression.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected owner to create regression file");
	}

	const snapshotsResult = await asOtherUser.query(api.files_nodes.get_file_snapshots_list, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		showArchived: false,
	});
	expect(snapshotsResult.snapshots).toEqual([]);

	const unauthorizedYjsUpdates = await asOtherUser.query(api.files_nodes.yjs_get_incremental_updates, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
	});
	expect(unauthorizedYjsUpdates).toBeNull();

	const unauthorizedYjsPush = await asOtherUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		update: new ArrayBuffer(0),
		sessionId: "cross-user-membership",
	});
	expect(unauthorizedYjsPush).toEqual({ _nay: { message: "Unauthorized" } });
});

test("files_tree_write rate limit runs before membership validation", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const otherDb = await t.run(async (ctx) => {
		const otherUserId = await ctx.db.insert("users", {
			clerkUserId: null,
		});

		return await test_mocks_fill_db_with.membership(ctx, {
			userId: otherUserId,
			workspaceName: "rl-other-ws",
			projectName: "rl-other-prj",
		});
	});
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Tree Rate User",
	});
	const createdNodeIds: Array<Id<"files_nodes">> = [];

	for (let i = 0; i < 2; i++) {
		const result = await asUser.action(api.files_nodes.create_markdown_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: `tree-rate-limit-${i}.md`,
		});
		if (result._nay) {
			throw new Error(`Expected tree write #${i + 1} to succeed, got: ${result._nay.message}`);
		}

		createdNodeIds.push(result._yay.nodeId);
	}

	const blocked = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: otherDb.membershipId,
		nodeId: createdNodeIds[0],
		name: "should-rate-limit-before-membership.md",
	});

	expect(blocked._nay?.message).toBe("Rate limit exceeded");
});

test("files_snapshot_write rate limit runs before restore snapshot validation", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const restoreAssets = await t.run(async (ctx) => {
		const [snapshotAssetId, currentSnapshotAssetId, restoredSnapshotAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/snapshot-rate-limit`,
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			nodeId: db.files.file_root_1._id,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
		});

		return { snapshotId, currentSnapshotAssetId, restoredSnapshotAssetId };
	});
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Snapshot Rate User",
	});

	for (let i = 0; i < 2; i++) {
		const result = await asUser.mutation(api.files_nodes.archive_snapshot, {
			membershipId: db.membershipId,
			snapshotId: restoreAssets.snapshotId,
		});
		if (result._nay) {
			throw new Error(`Expected snapshot write #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	const blocked = await asUser.mutation(internal.files_nodes.restore_snapshot, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		snapshotId: restoreAssets.snapshotId,
		sessionId: "snapshot-rate-limit",
		snapshotMarkdownContent: "",
		currentSnapshotAssetId: restoreAssets.currentSnapshotAssetId,
		currentSnapshotSize: 0,
		restoredSnapshotAssetId: restoreAssets.restoredSnapshotAssetId,
		restoredSnapshotSize: 0,
	});

	expect(blocked._nay?.message).toBe("Rate limit exceeded");
});

test("materialize_file_content writes empty Markdown and Yjs snapshots to R2", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Empty Materialize User",
		email: "empty-materialize-user@example.com",
	});
	const r2Writes = new Map<string, BodyInit>();
	generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return {
			key,
			url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
		};
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload") && init?.method === "PUT") {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				r2Writes.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			if (urlString.startsWith("https://r2.test/object?key=")) {
				const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
				const body = r2Writes.get(key);
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
			}

			return new Response(null, { status: 404 });
		}),
	);

	const createdFile = await asUser.action(internal.files_nodes.create_file_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path: "/empty-materialized.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const materialized = await t.action(internal.files_nodes.materialize_file_content, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		nodeId: createdFile._yay.nodeId,
		userId: db.userId,
		targetSequence: 0,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!node?.assetId || !node.yjsSnapshotId) {
			throw new Error("Expected materialized empty file docs");
		}
		const asset = await ctx.db.get("files_r2_assets", node.assetId);
		const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", createdFile._yay.nodeId),
			)
			.collect();
		const versionSnapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_workspace_project_file_archivedAt", (q) =>
				q
					.eq("workspaceId", db.workspaceId)
					.eq("projectId", db.projectId)
					.eq("nodeId", createdFile._yay.nodeId)
					.eq("archivedAt", -1),
			)
			.collect();
		const versionSnapshotAssets = await Promise.all(
			versionSnapshots.map((snapshot) => ctx.db.get("files_r2_assets", snapshot.assetId)),
		);

		return {
			asset,
			yjsSnapshot,
			yjsSnapshotAsset,
			yjsUpdates,
			versionSnapshots,
			versionSnapshotAssets,
		};
	});

	const versionSnapshotAsset = saved.versionSnapshotAssets.find((asset) => asset?.size === 0);
	expect(saved.asset).toMatchObject({
		r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${saved.asset?._id}`,
		size: 0,
	});
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${saved.yjsSnapshotAsset?._id}`,
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.versionSnapshots.length).toBeGreaterThan(0);
	expect(versionSnapshotAsset).toMatchObject({
		r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${versionSnapshotAsset?._id}`,
		size: 0,
	});
	expect(r2Writes.get(saved.asset!.r2Key!)).toBe("");
	expect(r2Writes.get(versionSnapshotAsset!.r2Key!)).toBe("");
	expect(r2Writes.has(saved.yjsSnapshotAsset!.r2Key!)).toBe(true);
});

test("materialize_file_content writes nonempty Markdown and Yjs snapshots to R2", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Materialize User",
		email: "materialize-user@example.com",
	});
	const r2Writes = new Map<string, BodyInit>();
	generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return {
			key,
			url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
		};
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload") && init?.method === "PUT") {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				r2Writes.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			if (urlString.startsWith("https://r2.test/object?key=")) {
				const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
				const body = r2Writes.get(key);
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
			}

			return new Response(null, { status: 404 });
		}),
	);

	const createdFile = await asUser.action(internal.files_nodes.create_file_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path: "/materialized.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const markdown = "# Café\n\nEmoji 🙂";
	const yjsDoc = files_yjs_doc_create_from_markdown({ markdown });
	if ("_nay" in yjsDoc) {
		throw new Error(yjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
		sessionId: "materialize-session",
	});
	yjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const materialized = await t.action(internal.files_nodes.materialize_file_content, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		nodeId: createdFile._yay.nodeId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!node?.assetId || !node.yjsSnapshotId) {
			throw new Error("Expected materialized file docs");
		}
		const asset = await ctx.db.get("files_r2_assets", node.assetId);
		const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", createdFile._yay.nodeId),
			)
			.collect();
		const versionSnapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_workspace_project_file_archivedAt", (q) =>
				q
					.eq("workspaceId", db.workspaceId)
					.eq("projectId", db.projectId)
					.eq("nodeId", createdFile._yay.nodeId)
					.eq("archivedAt", -1),
			)
			.collect();
		const versionSnapshotAssets = await Promise.all(
			versionSnapshots.map((snapshot) => ctx.db.get("files_r2_assets", snapshot.assetId)),
		);

		return {
			asset,
			yjsSnapshot,
			yjsSnapshotAsset,
			yjsUpdates,
			versionSnapshots,
			versionSnapshotAssets,
		};
	});

	const versionSnapshotAsset = saved.versionSnapshotAssets.find(
		(asset) => asset?.size === files_get_utf8_byte_size(markdown),
	);
	expect(saved.asset).toMatchObject({
		r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${saved.asset?._id}`,
		size: files_get_utf8_byte_size(markdown),
	});
	expect(saved.yjsSnapshot?.sequence).toBe(1);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${saved.yjsSnapshotAsset?._id}`,
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.versionSnapshots.length).toBeGreaterThan(0);
	expect(versionSnapshotAsset).toMatchObject({
		r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${versionSnapshotAsset?._id}`,
		size: files_get_utf8_byte_size(markdown),
	});
	expect(r2Writes.get(saved.asset!.r2Key!)).toBe(markdown);
	expect(r2Writes.get(versionSnapshotAsset!.r2Key!)).toBe(markdown);
	expect(r2Writes.has(saved.yjsSnapshotAsset!.r2Key!)).toBe(true);
});

test("create_file_snapshot_content_url returns a signed R2 URL without fetching snapshot Markdown", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Snapshot R2 User",
	});
	const snapshotMarkdown = "# R2 snapshot\n\nStored outside Convex.";
	const getUrlSpy = vi
		.spyOn(R2.prototype, "getUrl")
		.mockImplementation(async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`);

	const createdFile = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "snapshot-r2.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const nodeId = createdFile._yay.nodeId;
	const { snapshotId } = await t.run(async (ctx) => {
		const r2Key = `content/workspaces/${db.workspaceId}/projects/${db.projectId}/nodes/${nodeId}/versions/42/markdown`;
		const assetId = await ctx.db.insert("files_r2_assets", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			r2Key,
			size: files_get_utf8_byte_size(snapshotMarkdown),
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		const snapshotId = await ctx.db.insert("files_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			nodeId,
			assetId,
			createdBy: db.userId,
			archivedAt: 0,
		});

		return { snapshotId };
	});

	const fetchSpy = vi.fn(async () => {
		throw new Error("create_file_snapshot_content_url should not fetch from R2");
	});
	vi.stubGlobal("fetch", fetchSpy);

	const contentUrl = await asUser.action(api.files_nodes.create_file_snapshot_content_url, {
		membershipId: db.membershipId,
		nodeId,
		snapshotId,
	});
	expect(contentUrl).toMatchObject({
		url: `https://r2.test/object?key=${encodeURIComponent(
			`content/workspaces/${db.workspaceId}/projects/${db.projectId}/nodes/${nodeId}/versions/42/markdown`,
		)}`,
		snapshotId,
	});
	expect(getUrlSpy).toHaveBeenCalledWith(
		`content/workspaces/${db.workspaceId}/projects/${db.projectId}/nodes/${nodeId}/versions/42/markdown`,
		{ expiresIn: 15 * 60 },
	);
	expect(fetchSpy).not.toHaveBeenCalled();
});

test("create_file_snapshot_content_url fails when a snapshot asset has no R2 key", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Missing Snapshot R2 User",
	});

	const createdFile = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "missing-snapshot-r2.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const nodeId = createdFile._yay.nodeId;
	const { snapshotId } = await t.run(async (ctx) => {
		const assetId = await ctx.db.insert("files_r2_assets", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			size: 1,
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		const snapshotId = await ctx.db.insert("files_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			nodeId,
			assetId,
			createdBy: db.userId,
			archivedAt: 0,
		});

		return { snapshotId };
	});

	await expect(
		asUser.action(api.files_nodes.create_file_snapshot_content_url, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
		}),
	).rejects.toThrow("snapshot.assetId points to an asset without r2Key");
});

test("restore_snapshot_r2 restores from R2-backed content without Convex Markdown bodies", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Restore R2 User",
		email: "restore-r2-user@example.com",
	});
	const r2Objects = new Map<string, BodyInit>();
	generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return {
			key,
			url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
		};
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload?key=") && init?.method === "PUT") {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				r2Objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			if (urlString.startsWith("https://r2.test/object?key=")) {
				const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
				const body = r2Objects.get(key);
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
			}

			return new Response(null, { status: 404 });
		}),
	);

	const createdFile = await asUser.action(internal.files_nodes.create_file_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path: "/restore-r2.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const currentMarkdown = "# Current\n\nBefore restore.";
	const currentYjsDoc = files_yjs_doc_create_from_markdown({ markdown: currentMarkdown });
	if ("_nay" in currentYjsDoc) {
		throw new Error(currentYjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(currentYjsDoc)),
		sessionId: "restore-r2-current",
	});
	currentYjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}
	const materialized = await t.action(internal.files_nodes.materialize_file_content, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		nodeId: createdFile._yay.nodeId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	const restoredMarkdown = "# Restored\n\nFrom R2 snapshot.";
	const { snapshotId } = await t.run(async (ctx) => {
		const snapshotAssetId = await ctx.db.insert("files_r2_assets", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			size: files_get_utf8_byte_size(restoredMarkdown),
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		const snapshotR2Key = `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${snapshotAssetId}`;
		r2Objects.set(snapshotR2Key, restoredMarkdown);
		await ctx.db.patch("files_r2_assets", snapshotAssetId, { r2Key: snapshotR2Key });
		const snapshotId = await ctx.db.insert("files_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			nodeId: createdFile._yay.nodeId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
		});

		return { snapshotId };
	});

	const restoreResult = await asUser.action(api.files_nodes.restore_snapshot_r2, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		snapshotId,
		sessionId: "restore-r2-session",
	});
	if (restoreResult._nay) {
		throw new Error(restoreResult._nay.message);
	}

	const readResult = await asUser.action(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path: "/restore-r2.md",
	});
	expect(readResult?.content).toBe(restoredMarkdown);
	const saved = await t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!node?.assetId) {
			throw new Error("Expected restored node docs");
		}
		const asset = await ctx.db.get("files_r2_assets", node.assetId);

		return { asset };
	});
	expect(saved.asset?.size).toBe(files_get_utf8_byte_size(restoredMarkdown));
	const liveMarkdownR2Key = saved.asset?.r2Key;
	if (!liveMarkdownR2Key) {
		throw new Error("Expected restored Markdown asset R2 key");
	}
	expect(r2Objects.get(liveMarkdownR2Key)).toBe(restoredMarkdown);
	expect(Array.from(r2Objects.values())).toContain(currentMarkdown);
	expect(Array.from(r2Objects.values())).toContain(restoredMarkdown);
});

test("yjs_push_update enforces per-user rate limit and leaves DB untouched on rejection", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Rate Limit User",
		email: "rate-limit-user@example.com",
	});

	const createdFile = await asUser.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "rate-limit.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected owner to create rate-limit file");
	}

	const pushArgs = {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		update: new ArrayBuffer(0),
		sessionId: "rate-limit-session",
	};

	for (let i = 0; i < 2; i++) {
		const result = await asUser.mutation(api.files_nodes.yjs_push_update, pushArgs);
		if (result._nay) {
			throw new Error(`Expected initial push #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	const blocked = await asUser.mutation(api.files_nodes.yjs_push_update, pushArgs);
	if (!blocked._nay) {
		throw new Error("Expected third push to be rate limited");
	}
	expect(blocked._nay.message).toBe("Rate limit exceeded");

	const otherDb = await t.run(async (ctx) => {
		const otherUserId = await ctx.db.insert("users", {
			clerkUserId: null,
		});

		return await test_mocks_fill_db_with.membership(ctx, {
			userId: otherUserId,
			workspaceName: "yjs-rl-ws",
			projectName: "yjs-rl-prj",
		});
	});
	const blockedBeforeMembership = await asUser.mutation(api.files_nodes.yjs_push_update, {
		...pushArgs,
		membershipId: otherDb.membershipId,
		sessionId: "rate-limit-before-membership",
	});
	expect(blockedBeforeMembership._nay?.message).toBe("Rate limit exceeded");

	const stateAfterBlock = await t.run(async (ctx) => {
		const updates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", createdFile._yay.nodeId),
			)
			.collect();
		const lastSequence = await ctx.db
			.query("files_yjs_docs_last_sequences")
			.withIndex("by_workspace_project_file", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", createdFile._yay.nodeId),
			)
			.first();
		return {
			updateCount: updates.length,
			lastSequence: lastSequence?.lastSequence ?? null,
			createdByList: updates.map((update) => update.createdBy),
		};
	});
	expect(stateAfterBlock.updateCount).toBe(2);
	expect(stateAfterBlock.lastSequence).toBe(2);
	expect(stateAfterBlock.createdByList).toEqual([db.userId, db.userId]);
});

test("yjs_push_update rate limit applies to anonymous JWT identities", async () => {
	const t = test_convex();
	const anonymousUserId = await t.run(async (ctx) =>
		ctx.db.insert("users", {
			clerkUserId: null,
		}),
	);
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, anonymousUserId));
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx, { userId: anonymousUserId }));
	const asAnonymous = t.withIdentity({
		issuer: process.env.VITE_CONVEX_HTTP_URL!,
		subject: anonymousUserId,
		name: "Anonymous User",
	});

	const createdFile = await asAnonymous.action(api.files_nodes.create_markdown_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "rate-limit-anonymous.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected anonymous user to create rate-limit file");
	}

	const pushArgs = {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		update: new ArrayBuffer(0),
		sessionId: "rate-limit-anonymous-session",
	};

	for (let i = 0; i < 2; i++) {
		const result = await asAnonymous.mutation(api.files_nodes.yjs_push_update, pushArgs);
		if (result._nay) {
			throw new Error(`Expected anonymous push #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	const blocked = await asAnonymous.mutation(api.files_nodes.yjs_push_update, pushArgs);
	if (!blocked._nay) {
		throw new Error("Expected anonymous third push to be rate limited");
	}
	expect(blocked._nay.message).toBe("Rate limit exceeded");
});

test("restore_snapshot blocks Free users without enough credits before writing", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Restore Credits User",
		email: "restore-credits-user@example.com",
	});

	const createdFile = await asUser.action(internal.files_nodes.create_file_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path: "/restore-credit.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected file creation to succeed before restore credit test");
	}

	const restoredMarkdown = "# restored content\n";
	const restoreAssets = await t.run(async (ctx) => {
		const usageSnapshot = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_user", (q) => q.eq("userId", db.userId))
			.unique();
		if (!usageSnapshot?.meter) {
			throw new Error("Expected seeded billing snapshot");
		}
		await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
			meter: {
				...usageSnapshot.meter,
				balance: 0,
			},
		});

		const [snapshotAssetId, currentSnapshotAssetId, restoredSnapshotAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/restore-credit-snapshot`,
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			nodeId: createdFile._yay.nodeId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
		});

		return { snapshotId, currentSnapshotAssetId, restoredSnapshotAssetId };
	});

	const restoreResult = await asUser.mutation(internal.files_nodes.restore_snapshot, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		snapshotId: restoreAssets.snapshotId,
		sessionId: "restore-credit-test",
		snapshotMarkdownContent: restoredMarkdown,
		currentSnapshotAssetId: restoreAssets.currentSnapshotAssetId,
		currentSnapshotSize: 0,
		restoredSnapshotAssetId: restoreAssets.restoredSnapshotAssetId,
		restoredSnapshotSize: files_get_utf8_byte_size(restoredMarkdown),
	});
	expect(restoreResult._nay?.message).toBe("Insufficient funds");

	const yjsUpdates = await t.run((ctx) =>
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", createdFile._yay.nodeId),
			)
			.collect(),
	);
	expect(yjsUpdates).toHaveLength(0);
});

test("/api/files/contextual-prompt returns 429 before body validation and model work", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => {
		await seed_billing_snapshot_for_user(ctx, db.userId);
		const usageSnapshot = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_user", (q) => q.eq("userId", db.userId))
			.unique();
		if (!usageSnapshot?.meter) {
			throw new Error("Expected seeded billing snapshot");
		}
		await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
			meter: {
				...usageSnapshot.meter,
				balance: 0,
			},
		});
	});
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Inline AI Rate User",
		email: "inline-ai-rate-user@example.com",
	});

	for (let i = 0; i < 1; i++) {
		const response = await asUser.fetch("/api/files/contextual-prompt", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				prompt: "Continue this sentence",
				membershipId: db.membershipId,
				requestId: `inline_ai_rate_${i}`,
			}),
		});
		expect(response.status).toBe(402);
	}

	const blocked = await asUser.fetch("/api/files/contextual-prompt", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: "not json",
	});
	const blockedBody = await blocked.json();

	expect(blocked.status).toBe(429);
	expect(blockedBody.message).toBe("Rate limit exceeded");
	expect(typeof blockedBody.retryAfterMs).toBe("number");
});

test("restore_snapshot emits file_save usage for the restored Yjs sequence", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", {
			clerkUserId: "clerk-restore-billing-user",
		});
		return await test_mocks_fill_db_with.membership(ctx, { userId });
	});
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Restore Billing User",
		email: "restore-billing-user@example.com",
	});

	const createdFile = await asUser.action(internal.files_nodes.create_file_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path: "/restore-billing.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected file creation to succeed before restore billing test");
	}

	const restoredMarkdown = "# restored content\n";
	const restoreAssets = await t.run(async (ctx) => {
		const [snapshotAssetId, currentSnapshotAssetId, restoredSnapshotAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/restore-billing-snapshot`,
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				workspaceId: db.workspaceId,
				projectId: db.projectId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			nodeId: createdFile._yay.nodeId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
		});

		return { snapshotId, currentSnapshotAssetId, restoredSnapshotAssetId };
	});

	const restoreResult = await asUser.mutation(internal.files_nodes.restore_snapshot, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		snapshotId: restoreAssets.snapshotId,
		sessionId: "restore-billing-test",
		snapshotMarkdownContent: restoredMarkdown,
		currentSnapshotAssetId: restoreAssets.currentSnapshotAssetId,
		currentSnapshotSize: 0,
		restoredSnapshotAssetId: restoreAssets.restoredSnapshotAssetId,
		restoredSnapshotSize: files_get_utf8_byte_size(restoredMarkdown),
		restoreUpdate: files_u8_to_array_buffer(
			encodeStateAsUpdate(
				(() => {
					const yjsDoc = files_yjs_doc_create_from_markdown({ markdown: restoredMarkdown });
					if ("_nay" in yjsDoc) {
						throw new Error("Expected restored markdown to produce a Yjs doc");
					}

					return yjsDoc;
				})(),
			),
		),
	});
	if (restoreResult._nay) {
		throw new Error(`Expected restore to succeed, got: ${restoreResult._nay.message}`);
	}

	const { asset, yjsUpdates } = await t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		const asset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
		return {
			asset,
			yjsUpdates: await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_workspace_project_file_sequence", (q) =>
					q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", createdFile._yay.nodeId),
				)
				.collect(),
		};
	});
	expect(yjsUpdates).toHaveLength(1);
	expect(asset).toMatchObject({
		kind: "content",
		size: files_get_utf8_byte_size(restoredMarkdown),
	});
	expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
		events: [
			expect.objectContaining({
				name: "file_save",
				externalCustomerId: db.userId,
				externalId: `file_save::${db.userId}::${db.userId}::${db.workspaceId}::${db.projectId}::${createdFile._yay.nodeId}::${yjsUpdates[0]?.sequence}`,
				metadata: expect.objectContaining({
					amount: 1,
					actorUserId: db.userId,
					billedUserId: db.userId,
					workspaceId: db.workspaceId,
					projectId: db.projectId,
					nodeId: createdFile._yay.nodeId,
					yjsSequence: String(yjsUpdates[0]?.sequence),
				}),
			}),
		],
	});
});

describe("files_nodes.cleanup_old_snapshots", () => {
	test("keeps newest hourly daily and weekly buckets and deletes pruned R2 assets", async () => {
		vi.useFakeTimers();
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const nodeId = await t.run(async (ctx) =>
				ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					workspaceId: db.workspaceId,
					projectId: db.projectId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId: files_ROOT_ID,
					name: "retention.md",
					kind: "file",
					path: "/retention.md",
				}),
			);
			const insertSnapshot = async (label: string, timestamp: string) => {
				vi.setSystemTime(new Date(timestamp));
				return await t.run(async (ctx) => {
					const r2Key = `workspaces/${db.workspaceId}/projects/${db.projectId}/assets/${label}`;
					const assetId = await ctx.db.insert("files_r2_assets", {
						workspaceId: db.workspaceId,
						projectId: db.projectId,
						kind: "content_snapshot",
						r2Bucket: "test-bucket",
						r2Key,
						size: label.length,
						createdBy: db.userId,
						updatedAt: Date.now(),
					});
					const snapshotId = await ctx.db.insert("files_snapshots", {
						workspaceId: db.workspaceId,
						projectId: db.projectId,
						nodeId,
						assetId,
						createdBy: db.userId,
						archivedAt: -1,
					});

					return { snapshotId, assetId, r2Key };
				});
			};
			const outsideScanWindowKept = await insertSnapshot("outside-scan-window-kept", "2025-12-01T12:00:00.000Z");
			const weeklyDeleted = await insertSnapshot("weekly-deleted", "2026-01-28T12:00:00.000Z");
			const weeklyKept = await insertSnapshot("weekly-kept", "2026-01-30T12:00:00.000Z");
			const dailyDeleted = await insertSnapshot("daily-deleted", "2026-02-20T08:00:00.000Z");
			const dailyKept = await insertSnapshot("daily-kept", "2026-02-20T18:00:00.000Z");
			const hourlyDeleted = await insertSnapshot("hourly-deleted", "2026-03-05T12:10:00.000Z");
			const hourlyKept = await insertSnapshot("hourly-kept", "2026-03-05T12:50:00.000Z");
			const recentKept = await insertSnapshot("recent-kept", "2026-03-09T12:00:00.000Z");

			vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));
			await t.run((ctx) => ctx.runMutation(internal.files_nodes.cleanup_old_snapshots, {}));

			const remaining = await t.run(async (ctx) => {
				const [snapshots, outsideScanWindowAsset, deletedWeeklyAsset, deletedDailyAsset, deletedHourlyAsset] =
					await Promise.all([
						ctx.db
							.query("files_snapshots")
							.withIndex("by_workspace_project_file_archivedAt", (q) =>
								q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", nodeId),
							)
							.collect(),
						ctx.db.get("files_r2_assets", outsideScanWindowKept.assetId),
						ctx.db.get("files_r2_assets", weeklyDeleted.assetId),
						ctx.db.get("files_r2_assets", dailyDeleted.assetId),
						ctx.db.get("files_r2_assets", hourlyDeleted.assetId),
					]);

				return {
					snapshotIds: snapshots.map((snapshot) => snapshot._id),
					outsideScanWindowAsset,
					deletedWeeklyAsset,
					deletedDailyAsset,
					deletedHourlyAsset,
				};
			});

			expect(remaining.snapshotIds).toEqual(
				expect.arrayContaining([
					outsideScanWindowKept.snapshotId,
					weeklyKept.snapshotId,
					dailyKept.snapshotId,
					hourlyKept.snapshotId,
					recentKept.snapshotId,
				]),
			);
			expect(remaining.snapshotIds).not.toContain(weeklyDeleted.snapshotId);
			expect(remaining.snapshotIds).not.toContain(dailyDeleted.snapshotId);
			expect(remaining.snapshotIds).not.toContain(hourlyDeleted.snapshotId);
			expect(remaining.outsideScanWindowAsset?._id).toBe(outsideScanWindowKept.assetId);
			expect(remaining.deletedWeeklyAsset).toBeNull();
			expect(remaining.deletedDailyAsset).toBeNull();
			expect(remaining.deletedHourlyAsset).toBeNull();
			expect(deleteObjectSpy).not.toHaveBeenCalledWith(expect.anything(), outsideScanWindowKept.r2Key);
			expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), weeklyDeleted.r2Key);
			expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), dailyDeleted.r2Key);
			expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), hourlyDeleted.r2Key);
		} finally {
			vi.useRealTimers();
		}
	});
});
