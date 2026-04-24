import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { math_clamp } from "../shared/shared-utils.ts";
import { minimatch } from "minimatch";
import { server_path_normalize } from "../server/server-utils.ts";
import { pages_ROOT_ID } from "../server/pages.ts";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { billing_PRODUCTS } from "../shared/billing.ts";

beforeEach(() => {
	// Keep page tests focused on page behavior; billing event enqueue behavior is
	// covered in billing tests.
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_page_test_billing_event" as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function seed_billing_snapshot_for_user(ctx: MutationCtx, userId: Id<"users">) {
	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("byUser", (q) => q.eq("userId", userId))
		.unique();
	if (usageSnapshot) return;

	const polarProductId = "pages_test_free_product";
	const existingProduct = await ctx.runQuery(components.polar.lib.getProduct, { id: polarProductId });
	if (!existingProduct) {
		await ctx.runMutation(components.polar.lib.createProduct, {
			product: {
				id: polarProductId,
				organizationId: "pages_test_org",
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
		polarCustomerId: `pages_test_customer_${userId}`,
		subscription: {
			id: `pages_test_subscription_${userId}`,
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

test("list_pages", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
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

	const result_list_page_root_1 = await list_dir({
		runQuery: asUser.query,
		workspaceId: db.workspaceId,
		projectId: db.projectId,
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

test("list_pages_new", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const result_root = await asUser.query(internal.ai_docs_temp.list_pages, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
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

	const result_under_root1 = await asUser.query(internal.ai_docs_temp.list_pages, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
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
	const result_depth1 = await asUser.query(internal.ai_docs_temp.list_pages, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
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

test("resolve_page_id_from_path uses materialized paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const root1Path = `/${db.pages.page_root_1.name}`;
	const child1Path = `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}`;
	const deep1Path = `/${db.pages.page_root_1.name}/${db.pages.page_root_1_child_1.name}/${db.pages.page_root_1_child_1_deep_1.name}`;

	const [root1Id, child1Id, deep1Id] = await Promise.all([
		asUser.query(internal.ai_docs_temp.resolve_page_id_from_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: root1Path,
		}),
		asUser.query(internal.ai_docs_temp.resolve_page_id_from_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: child1Path,
		}),
		asUser.query(internal.ai_docs_temp.resolve_page_id_from_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: deep1Path,
		}),
	]);

	expect(root1Id).toBe(db.pages.page_root_1._id);
	expect(child1Id).toBe(db.pages.page_root_1_child_1._id);
	expect(deep1Id).toBe(db.pages.page_root_1_child_1_deep_1._id);
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
		membershipId: db.membershipId,
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
		membershipId: db.membershipId,
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

	const ensuredHomepage = await asUser.mutation(api.ai_docs_temp.create_home_page, {
		membershipId: db.membershipId,
	});
	if (ensuredHomepage._nay) {
		throw new Error("create_home_page failed in test");
	}
	const homepageId = ensuredHomepage._yay.pageId;

	await asUser.mutation(api.ai_docs_temp.rename_page, {
		membershipId: db.membershipId,
		pageId: homepageId,
		name: "renamed_home",
	});

	await asUser.mutation(api.ai_docs_temp.move_pages, {
		itemIds: [homepageId],
		targetParentId: db.pages.page_root_1._id,
		membershipId: db.membershipId,
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
		membershipId: db.membershipId,
	});

	if (duplicateCreation._yay) {
		throw new Error("Expected duplicate creation to fail");
	}

	expect(duplicateCreation._nay.message).toContain("path already exists");
});

test("create_page rejects names containing path separator characters", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});
	const invalidNames = ["invalid/name", "invalid\\name"];

	for (const invalidName of invalidNames) {
		const result = await asUser.mutation(api.ai_docs_temp.create_page, {
			parentId: pages_ROOT_ID,
			name: invalidName,
			membershipId: db.membershipId,
		});

		if (result._yay) {
			throw new Error("Expected create_page to fail for invalid page name");
		}

		expect(result._nay.message).toContain("Invalid page name");
	}

	await t.run(async (ctx) => {
		for (const invalidName of invalidNames) {
			const invalidPages = await ctx.db
				.query("pages")
				.withIndex("byWorkspaceProjectParentName", (q) =>
					q
						.eq("workspaceId", db.workspaceId)
						.eq("projectId", db.projectId)
						.eq("parentId", pages_ROOT_ID)
						.eq("name", invalidName),
				)
				.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
				.collect();

			expect(invalidPages).toHaveLength(0);
		}
	});
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
		membershipId: db.membershipId,
	});
	if (createdPage._nay) {
		throw new Error("Expected initial page creation to succeed");
	}

	await asUser.mutation(api.ai_docs_temp.archive_pages, {
		membershipId: db.membershipId,
		pageIds: [createdPage._yay.pageId],
	});

	const recreatedPage = await asUser.mutation(api.ai_docs_temp.create_page, {
		parentId: pages_ROOT_ID,
		name: duplicateName,
		membershipId: db.membershipId,
	});
	if (recreatedPage._nay) {
		throw new Error("Expected recreated page creation to succeed");
	}

	await t.run(async (ctx) => {
		const path = `/${duplicateName}`;
		const pagesAtPath = await ctx.db
			.query("pages")
			.withIndex("byWorkspaceProjectPathArchiveOperation", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("path", path),
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
		membershipId: db.membershipId,
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

test("rename_page rejects names containing path separator characters and keeps original values", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});
	const invalidNames = ["invalid/name", "invalid\\name"];

	const before = await t.run(async (ctx) => ctx.db.get("pages", db.pages.page_root_2._id));

	for (const invalidName of invalidNames) {
		const renameResult = await asUser.mutation(api.ai_docs_temp.rename_page, {
			membershipId: db.membershipId,
			pageId: db.pages.page_root_2._id,
			name: invalidName,
		});

		if (renameResult._yay !== undefined) {
			throw new Error("Expected rename_page to fail for invalid page name");
		}

		expect(renameResult._nay.message).toContain("Invalid page name");
	}

	const after = await t.run(async (ctx) => ctx.db.get("pages", db.pages.page_root_2._id));
	expect(after?.name).toBe(before?.name);
	expect(after?.path).toBe(before?.path);
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
		membershipId: db.membershipId,
	});
	if (conflictingSibling._nay) {
		throw new Error("Expected conflicting sibling creation to succeed");
	}

	const moveResult = await asUser.mutation(api.ai_docs_temp.move_pages, {
		itemIds: [db.pages.page_root_1_child_1._id],
		targetParentId: db.pages.page_root_2._id,
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
		membershipId: db.membershipId,
		pageIds: [db.pages.page_root_2._id],
	});

	const renameArchived = await asUser.mutation(api.ai_docs_temp.rename_page, {
		membershipId: db.membershipId,
		pageId: db.pages.page_root_2._id,
		name: db.pages.page_root_1.name,
	});
	if (renameArchived._nay) {
		throw new Error("Expected archived rename to succeed");
	}

	const unarchiveResult = await asUser.mutation(api.ai_docs_temp.unarchive_pages, {
		membershipId: db.membershipId,
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
		membershipId: db.membershipId,
		pageIds: [db.pages.page_root_1._id],
	});

	const unarchiveResult = await asUser.mutation(api.ai_docs_temp.unarchive_pages, {
		membershipId: db.membershipId,
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
		membershipId: db.membershipId,
		pageIds: [db.pages.page_root_2._id],
	});

	const renameArchived = await asUser.mutation(api.ai_docs_temp.rename_page, {
		membershipId: db.membershipId,
		pageId: db.pages.page_root_2._id,
		name: db.pages.page_root_1.name,
	});
	if (renameArchived._nay) {
		throw new Error("Expected archived rename to succeed");
	}

	const resolvedRoot1 = await asUser.query(internal.ai_docs_temp.resolve_page_id_from_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		path: `/${db.pages.page_root_1.name}`,
	});

	expect(resolvedRoot1).toBe(db.pages.page_root_1._id);
});

test("create_page_by_path rejects invalid path segments", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
		name: "Test User",
	});

	const invalidPath = "/invalid_parent/invalid\\name";
	const createByPath = await asUser.mutation(internal.ai_docs_temp.create_page_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		path: invalidPath,
	});

	if (createByPath._yay) {
		throw new Error("Expected create_page_by_path to fail for invalid path segment");
	}

	expect(createByPath._nay.message).toContain("Invalid page name");

	await t.run(async (ctx) => {
		const invalidParentRows = await ctx.db
			.query("pages")
			.withIndex("byWorkspaceProjectParentName", (q) =>
				q
					.eq("workspaceId", db.workspaceId)
					.eq("projectId", db.projectId)
					.eq("parentId", pages_ROOT_ID)
					.eq("name", "invalid_parent"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.collect();

		expect(invalidParentRows).toHaveLength(0);
	});
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
		membershipId: db.membershipId,
		pageIds: [db.pages.page_root_2._id],
	});

	const createByPath = await asUser.mutation(internal.ai_docs_temp.create_page_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		path: `/${db.pages.page_root_2.name}/new_leaf`,
	});
	if (createByPath._nay) {
		throw new Error("Expected create_page_by_path to succeed with archived duplicate ancestor");
	}

	await t.run(async (ctx) => {
		const root2Path = `/${db.pages.page_root_2.name}`;
		const pagesAtRoot2Path = await ctx.db
			.query("pages")
			.withIndex("byWorkspaceProjectPathArchiveOperation", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("path", root2Path),
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
	const startNodeId = await args.runQuery(internal.ai_docs_temp.resolve_tree_node_id_from_path, {
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

		const paginatedResult = await args.runQuery(internal.ai_docs_temp.get_page_info_for_list_dir_pagination, {
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
		membershipId: db.membershipId,
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
		membershipId: db.membershipId,
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
		membershipId: db.membershipId,
		pageIds: [db.pages.page_root_2._id],
	});

	const archiveAgain = await asUser.mutation(api.ai_docs_temp.archive_pages, {
		membershipId: db.membershipId,
		pageIds: [db.pages.page_root_2._id],
	});
	expect(archiveAgain).not.toHaveProperty("_nay");

	const unarchiveResult = await asUser.mutation(api.ai_docs_temp.unarchive_pages, {
		membershipId: db.membershipId,
		pageIds: [db.pages.page_root_2._id],
	});
	expect(unarchiveResult).not.toHaveProperty("_nay");

	const unarchiveAgain = await asUser.mutation(api.ai_docs_temp.unarchive_pages, {
		membershipId: db.membershipId,
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
		membershipId: db.membershipId,
		pageIds: [db.pages.page_root_1_child_1._id],
	});

	await asUser.mutation(api.ai_docs_temp.archive_pages, {
		membershipId: db.membershipId,
		pageIds: [db.pages.page_root_1._id],
	});

	await asUser.mutation(api.ai_docs_temp.unarchive_pages, {
		membershipId: db.membershipId,
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

test("membership-scoped page and yjs APIs reject cross-user membership ids", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	const ownerIdentity = {
		issuer: "https://clerk.test",
		external_id: db.pages.page_root_1.createdBy,
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

	const unauthorizedRename = await asOtherUser.mutation(api.ai_docs_temp.rename_page, {
		membershipId: db.membershipId,
		pageId: db.pages.page_root_1._id,
		name: "should-not-rename",
	});
	if (!unauthorizedRename._nay) {
		throw new Error("Expected rename_page to reject cross-user membership access");
	}
	expect(unauthorizedRename._nay.message).toBe("Unauthorized");

	const createdPage = await asOwner.mutation(api.ai_docs_temp.create_page, {
		membershipId: db.membershipId,
		parentId: pages_ROOT_ID,
		name: "membership-yjs-regression-page",
	});
	if (createdPage._nay) {
		throw new Error("Expected owner to create regression page");
	}

	const snapshotsResult = await asOtherUser.query(api.ai_docs_temp.get_page_snapshots_list, {
		membershipId: db.membershipId,
		pageId: createdPage._yay.pageId,
		showArchived: false,
	});
	expect(snapshotsResult.snapshots).toEqual([]);

	const unauthorizedYjsSnapshot = await asOtherUser.query(api.ai_docs_temp.yjs_get_doc_last_snapshot, {
		membershipId: db.membershipId,
		pageId: createdPage._yay.pageId,
	});
	expect(unauthorizedYjsSnapshot).toBeNull();

	const unauthorizedYjsUpdates = await asOtherUser.query(api.ai_docs_temp.yjs_get_incremental_updates, {
		membershipId: db.membershipId,
		pageId: createdPage._yay.pageId,
	});
	expect(unauthorizedYjsUpdates).toBeNull();

	const unauthorizedYjsPush = await asOtherUser.mutation(api.ai_docs_temp.yjs_push_update, {
		membershipId: db.membershipId,
		pageId: createdPage._yay.pageId,
		update: new ArrayBuffer(0),
		sessionId: "cross-user-membership",
	});
	expect(unauthorizedYjsPush).toEqual({ _nay: { message: "Unauthorized" } });
});

test("yjs_push_update enforces per-user rate limit and leaves DB untouched on rejection", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_pages(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Rate Limit User",
		email: "rate-limit-user@example.com",
	});

	const createdPage = await asUser.mutation(api.ai_docs_temp.create_page, {
		membershipId: db.membershipId,
		parentId: pages_ROOT_ID,
		name: "rate-limit-page",
	});
	if (createdPage._nay) {
		throw new Error("Expected owner to create rate-limit page");
	}

	const pushArgs = {
		membershipId: db.membershipId,
		pageId: createdPage._yay.pageId,
		update: new ArrayBuffer(0),
		sessionId: "rate-limit-session",
	};

	for (let i = 0; i < 2; i++) {
		const result = await asUser.mutation(api.ai_docs_temp.yjs_push_update, pushArgs);
		if (result._nay) {
			throw new Error(`Expected initial push #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	const blocked = await asUser.mutation(api.ai_docs_temp.yjs_push_update, pushArgs);
	if (!blocked._nay) {
		throw new Error("Expected third push to be rate limited");
	}
	expect(blocked._nay.message).toBe("Rate limit exceeded");

	const stateAfterBlock = await t.run(async (ctx) => {
		const updates = await ctx.db
			.query("pages_yjs_updates")
			.withIndex("byWorkspaceProjectPageSequence", (q) =>
				q
					.eq("workspaceId", db.workspaceId)
					.eq("projectId", db.projectId)
					.eq("pageId", createdPage._yay.pageId),
			)
			.collect();
		const lastSequence = await ctx.db
			.query("pages_yjs_docs_last_sequences")
			.withIndex("byWorkspaceProjectPage", (q) =>
				q
					.eq("workspaceId", db.workspaceId)
					.eq("projectId", db.projectId)
					.eq("pageId", createdPage._yay.pageId),
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

	const createdPage = await asAnonymous.mutation(api.ai_docs_temp.create_page, {
		membershipId: db.membershipId,
		parentId: pages_ROOT_ID,
		name: "rate-limit-anonymous-page",
	});
	if (createdPage._nay) {
		throw new Error("Expected anonymous user to create rate-limit page");
	}

	const pushArgs = {
		membershipId: db.membershipId,
		pageId: createdPage._yay.pageId,
		update: new ArrayBuffer(0),
		sessionId: "rate-limit-anonymous-session",
	};

	for (let i = 0; i < 2; i++) {
		const result = await asAnonymous.mutation(api.ai_docs_temp.yjs_push_update, pushArgs);
		if (result._nay) {
			throw new Error(`Expected anonymous push #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	const blocked = await asAnonymous.mutation(api.ai_docs_temp.yjs_push_update, pushArgs);
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

	const createdPage = await asUser.mutation(api.ai_docs_temp.create_page, {
		membershipId: db.membershipId,
		parentId: pages_ROOT_ID,
		name: "restore-credit-page",
	});
	if (createdPage._nay) {
		throw new Error("Expected page creation to succeed before restore credit test");
	}

	const pageSnapshotId = await t.run(async (ctx) => {
		const usageSnapshot = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("byUser", (q) => q.eq("userId", db.userId))
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

		const snapshotId = await ctx.db.insert("pages_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			pageId: createdPage._yay.pageId,
			createdBy: db.userId,
			archivedAt: 0,
		});
		await ctx.db.insert("pages_snapshots_contents", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			pageSnapshotId: snapshotId,
			pageId: createdPage._yay.pageId,
			content: "# restored content\n",
		});

		return snapshotId;
	});

	const restoreResult = await asUser.mutation(api.ai_docs_temp.restore_snapshot, {
		membershipId: db.membershipId,
		pageId: createdPage._yay.pageId,
		pageSnapshotId,
		sessionId: "restore-credit-test",
		currentMarkdownContent: "",
	});
	expect(restoreResult._nay?.message).toBe("Insufficient funds");

	const yjsUpdates = await t.run((ctx) =>
		ctx.db
			.query("pages_yjs_updates")
			.withIndex("byWorkspaceProjectPageSequence", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("pageId", createdPage._yay.pageId),
			)
			.collect(),
	);
	expect(yjsUpdates).toHaveLength(0);
});

test("/api/ai-docs-temp/contextual-prompt returns 429 on the third inline AI request before model work", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => {
		await seed_billing_snapshot_for_user(ctx, db.userId);
		const usageSnapshot = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("byUser", (q) => q.eq("userId", db.userId))
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

	for (let i = 0; i < 2; i++) {
		const response = await asUser.fetch("/api/ai-docs-temp/contextual-prompt", {
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

	const blocked = await asUser.fetch("/api/ai-docs-temp/contextual-prompt", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			prompt: "Continue this sentence",
			membershipId: db.membershipId,
			requestId: "inline_ai_rate_blocked",
		}),
	});
	const blockedBody = await blocked.json();

	expect(blocked.status).toBe(429);
	expect(blockedBody.message).toBe("Rate limit exceeded");
	expect(typeof blockedBody.retryAfterMs).toBe("number");
});

test("restore_snapshot emits page_save usage for the restored Yjs sequence", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Restore Billing User",
		email: "restore-billing-user@example.com",
	});

	const createdPage = await asUser.mutation(api.ai_docs_temp.create_page, {
		membershipId: db.membershipId,
		parentId: pages_ROOT_ID,
		name: "restore-billing-page",
	});
	if (createdPage._nay) {
		throw new Error("Expected page creation to succeed before restore billing test");
	}

	const pageSnapshotId = await t.run(async (ctx) => {
		const snapshotId = await ctx.db.insert("pages_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			pageId: createdPage._yay.pageId,
			createdBy: db.userId,
			archivedAt: 0,
		});
		await ctx.db.insert("pages_snapshots_contents", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			pageSnapshotId: snapshotId,
			pageId: createdPage._yay.pageId,
			content: "# restored content\n",
		});

		return snapshotId;
	});

	const restoreResult = await asUser.mutation(api.ai_docs_temp.restore_snapshot, {
		membershipId: db.membershipId,
		pageId: createdPage._yay.pageId,
		pageSnapshotId,
		sessionId: "restore-billing-test",
		currentMarkdownContent: "",
	});
	if (restoreResult._nay) {
		throw new Error(`Expected restore to succeed, got: ${restoreResult._nay.message}`);
	}

	const yjsUpdates = await t.run((ctx) =>
		ctx.db
			.query("pages_yjs_updates")
			.withIndex("byWorkspaceProjectPageSequence", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("pageId", createdPage._yay.pageId),
			)
			.collect(),
	);
	expect(yjsUpdates).toHaveLength(1);
	expect(vi.mocked(Workpool.prototype.enqueueAction)).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
		events: [
			expect.objectContaining({
				name: "page_save",
				externalCustomerId: db.userId,
				externalId: `page_save::${db.userId}::${createdPage._yay.pageId}::${yjsUpdates[0]?.sequence}`,
				metadata: expect.objectContaining({
					amount: 1,
					pageId: createdPage._yay.pageId,
					yjsSequence: String(yjsUpdates[0]?.sequence),
				}),
			}),
		],
	});
});
