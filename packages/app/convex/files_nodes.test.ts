import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { math_clamp } from "../shared/shared-utils.ts";
import { minimatch } from "minimatch";
import { server_path_normalize } from "../server/server-utils.ts";
import { files_FIRST_VERSION, files_ROOT_ID } from "../server/files.ts";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { billing_PRODUCTS } from "../shared/billing.ts";

let enqueueActionSpy: MockInstance;

beforeEach(() => {
	// Keep file tests focused on file behavior; billing event enqueue behavior is
	// covered in billing tests.
	enqueueActionSpy = vi
		.spyOn(Workpool.prototype, "enqueueAction")
		.mockResolvedValue("work_file_test_billing_event" as never);
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

test("resolve_file_id_from_path uses materialized paths", async () => {
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

	const [root1Id, child1Id, deep1Id] = await Promise.all([
		asUser.query(internal.files_nodes.resolve_file_id_from_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: root1Path,
		}),
		asUser.query(internal.files_nodes.resolve_file_id_from_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: child1Path,
		}),
		asUser.query(internal.files_nodes.resolve_file_id_from_path, {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			path: deep1Path,
		}),
	]);

	expect(root1Id).toBe(db.files.file_root_1._id);
	expect(child1Id).toBe(db.files.file_root_1_child_1._id);
	expect(deep1Id).toBe(db.files.file_root_1_child_1_deep_1._id);
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
			name: "readme.md",
			kind: "file",
			path: "/readme.md",
			version: files_FIRST_VERSION,
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
		expect(homeFile?.name).toBe("readme.md");
		expect(homeFile?.path).toBe("/readme.md");
		expect(homeFile?.parentId).toBe(files_ROOT_ID);
	});
});

test("create_node rejects duplicate active path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const duplicateCreation = await asUser.mutation(api.files_nodes.create_node, {
		parentId: files_ROOT_ID,
		name: db.files.file_root_1.name,
		kind: "folder",
		membershipId: db.membershipId,
	});

	if (duplicateCreation._yay) {
		throw new Error("Expected duplicate creation to fail");
	}

	expect(duplicateCreation._nay.message).toContain("path already exists");
});

test("create_node rejects names containing path separator characters", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});
	const invalidNames = ["invalid/name", "invalid\\name"];

	for (const invalidName of invalidNames) {
		const result = await asUser.mutation(api.files_nodes.create_node, {
			parentId: files_ROOT_ID,
			name: invalidName,
			kind: "folder",
			membershipId: db.membershipId,
		});

		if (result._yay) {
			throw new Error("Expected create_node to fail for invalid file name");
		}

		expect(result._nay.message).toContain("Invalid");
	}

	await t.run(async (ctx) => {
		for (const invalidName of invalidNames) {
			const invalidFiles = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_parent_name", (q) =>
					q
						.eq("workspaceId", db.workspaceId)
						.eq("projectId", db.projectId)
						.eq("parentId", files_ROOT_ID)
						.eq("name", invalidName),
				)
				.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
				.collect();

			expect(invalidFiles).toHaveLength(0);
		}
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

	const createdFile = await asUser.mutation(internal.files_nodes.create_file_by_path, {
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

	const recreatedFile = await asUser.mutation(api.files_nodes.create_node, {
		parentId: files_ROOT_ID,
		name: duplicateName,
		kind: "file",
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

test("rename_node rejects names containing path separator characters and keeps original values", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});
	const invalidNames = ["invalid/name", "invalid\\name"];

	const before = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_2._id));

	for (const invalidName of invalidNames) {
		const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			nodeId: db.files.file_root_2._id,
			name: invalidName,
		});

		if (renameResult._yay !== undefined) {
			throw new Error("Expected rename_node to fail for invalid file name");
		}

		expect(renameResult._nay.message).toContain("Invalid");
	}

	const after = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_2._id));
	expect(after?.name).toBe(before?.name);
	expect(after?.path).toBe(before?.path);
});

test("move_nodes returns conflict and keeps original path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const conflictingSibling = await asUser.mutation(api.files_nodes.create_node, {
		parentId: db.files.file_root_2._id,
		name: db.files.file_root_1_child_1.name,
		kind: "folder",
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

test("unarchive_nodes excludes unrequested ancestors from archive operation", async () => {
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

test("resolve_file_id_from_path ignores archived files with duplicate path", async () => {
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

	const resolvedRoot1 = await asUser.query(internal.files_nodes.resolve_file_id_from_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		path: `/${db.files.file_root_1.name}`,
	});

	expect(resolvedRoot1).toBe(db.files.file_root_1._id);
});

test("create_file_by_path rejects invalid path segments", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.files.file_root_1.createdBy,
		name: "Test User",
	});

	const invalidPath = "/invalid_parent/invalid\\name";
	const createByPath = await asUser.mutation(internal.files_nodes.create_file_by_path, {
		workspaceId: db.workspaceId,
		projectId: db.projectId,
		userId: db.userId,
		path: invalidPath,
	});

	if (createByPath._yay) {
		throw new Error("Expected create_file_by_path to fail for invalid path segment");
	}

	expect(createByPath._nay.message).toContain("Invalid");

	await t.run(async (ctx) => {
		const invalidParentRows = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_parent_name", (q) =>
				q
					.eq("workspaceId", db.workspaceId)
					.eq("projectId", db.projectId)
					.eq("parentId", files_ROOT_ID)
					.eq("name", "invalid_parent"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.collect();

		expect(invalidParentRows).toHaveLength(0);
	});
});

test("create_file_by_path reuses only active files", async () => {
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

	const createByPath = await asUser.mutation(internal.files_nodes.create_file_by_path, {
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

	const createdFile = await asOwner.mutation(api.files_nodes.create_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "membership-yjs-regression.md",
		kind: "file",
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

	const unauthorizedYjsSnapshot = await asOtherUser.query(api.files_nodes.yjs_get_doc_last_snapshot, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
	});
	expect(unauthorizedYjsSnapshot).toBeNull();

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
		const result = await asUser.mutation(api.files_nodes.create_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			name: `tree-rate-limit-${i}.md`,
			kind: "file",
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
	const snapshotId = await t.run(async (ctx) =>
		ctx.db.insert("files_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			nodeId: db.files.file_root_1._id,
			createdBy: db.userId,
			archivedAt: 0,
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Snapshot Rate User",
	});

	for (let i = 0; i < 2; i++) {
		const result = await asUser.mutation(api.files_nodes.archive_snapshot, {
			membershipId: db.membershipId,
			snapshotId,
		});
		if (result._nay) {
			throw new Error(`Expected snapshot write #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	const blocked = await asUser.mutation(api.files_nodes.restore_snapshot, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		snapshotId,
		sessionId: "snapshot-rate-limit",
		currentMarkdownContent: "",
	});

	expect(blocked._nay?.message).toBe("Rate limit exceeded");
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

	const createdFile = await asUser.mutation(api.files_nodes.create_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "rate-limit.md",
		kind: "file",
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

	const createdFile = await asAnonymous.mutation(api.files_nodes.create_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "rate-limit-anonymous.md",
		kind: "file",
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

	const createdFile = await asUser.mutation(api.files_nodes.create_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "restore-credit.md",
		kind: "file",
	});
	if (createdFile._nay) {
		throw new Error("Expected file creation to succeed before restore credit test");
	}

	const snapshotId = await t.run(async (ctx) => {
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

		const snapshotId = await ctx.db.insert("files_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			nodeId: createdFile._yay.nodeId,
			createdBy: db.userId,
			archivedAt: 0,
		});
		await ctx.db.insert("files_snapshots_contents", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			snapshotId: snapshotId,
			nodeId: createdFile._yay.nodeId,
			content: "# restored content\n",
		});

		return snapshotId;
	});

	const restoreResult = await asUser.mutation(api.files_nodes.restore_snapshot, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		snapshotId,
		sessionId: "restore-credit-test",
		currentMarkdownContent: "",
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

	const createdFile = await asUser.mutation(api.files_nodes.create_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		name: "restore-billing.md",
		kind: "file",
	});
	if (createdFile._nay) {
		throw new Error("Expected file creation to succeed before restore billing test");
	}

	const snapshotId = await t.run(async (ctx) => {
		const snapshotId = await ctx.db.insert("files_snapshots", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			nodeId: createdFile._yay.nodeId,
			createdBy: db.userId,
			archivedAt: 0,
		});
		await ctx.db.insert("files_snapshots_contents", {
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			snapshotId: snapshotId,
			nodeId: createdFile._yay.nodeId,
			content: "# restored content\n",
		});

		return snapshotId;
	});

	const restoreResult = await asUser.mutation(api.files_nodes.restore_snapshot, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		snapshotId,
		sessionId: "restore-billing-test",
		currentMarkdownContent: "",
	});
	if (restoreResult._nay) {
		throw new Error(`Expected restore to succeed, got: ${restoreResult._nay.message}`);
	}

	const yjsUpdates = await t.run((ctx) =>
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("projectId", db.projectId).eq("nodeId", createdFile._yay.nodeId),
			)
			.collect(),
	);
	expect(yjsUpdates).toHaveLength(1);
	expect(enqueueActionSpy).toHaveBeenCalledWith(
		expect.anything(),
		internal.billing.ingest_events,
		{
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
		},
	);
});
