import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi, type MockInstance } from "vitest";
import {
	applyUpdate,
	Doc as YjsDoc,
	XmlElement as YXmlElement,
	encodeStateAsUpdate,
	encodeStateAsUpdateV2,
	encodeStateVector,
	mergeUpdates,
} from "yjs";
import { Result } from "common/errors-as-values-utils.ts";
import { api, components, internal } from "./_generated/api.js";
import {
	files_db_yjs_push_update,
	files_line_range_from_text,
	files_node_require_writable,
	files_nodes_db_apply_pending_move,
	files_tail_lines_from_text,
	yjs_reserve_and_increment_last_sequence,
} from "./files_nodes.ts";
import {
	db_insert_file_text_content,
	files_nodes_create_yjs_snapshot_update_from_text,
	files_nodes_db_fill_text_node_content,
} from "./files_nodes_content.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	files_MAX_UPLOADS_BYTES,
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES,
	files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
	files_MAX_YJS_RECONSTRUCTED_STATE_BYTES,
	files_MAX_YJS_WIRE_BYTES,
	files_node_has_editable_yjs_state,
	files_ROOT_ID,
	files_INITIAL_CONTENT,
	files_UPLOAD_PATH_TAKEN_MESSAGE,
	files_YJS_DOC_KEYS,
	files_get_utf8_byte_size,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import {
	files_yjs_doc_create_from_text,
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
} from "../shared/files-tiptap.ts";
import { files_yjs_doc_clone, files_yjs_compute_diff_update_from_yjs_doc } from "../shared/files-yjs.ts";
import { r2_confirmed_object_delete, r2_create_asset_key, r2_server_side_copy } from "./r2_client.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { files_metadata_MAX_FRONTMATTER_FIELDS, type files_metadata_SearchPlan } from "../shared/files-metadata.ts";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>();
	return {
		...actual,
		generateText: generateTextMock,
		streamText: streamTextMock,
	};
});

let enqueueActionSpy: MockInstance;
let generateUploadUrlSpy: ReturnType<typeof vi.fn<(customKey?: string) => Promise<{ key: string; url: string }>>>;
const test = baseTest;

beforeEach(() => {
	generateTextMock.mockReset();
	streamTextMock.mockReset();
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

describe("bounded read line helpers", () => {
	test("files_line_range_from_text slices a 1-based line range", () => {
		const content = "a\nb\nc\nd\ne\n";
		expect(files_line_range_from_text(content, 1, 2)).toMatchObject({
			content: "a\nb\n",
			linesReturned: 2,
			moreLines: true,
		});
		expect(files_line_range_from_text(content, 3, 2)).toMatchObject({
			content: "c\nd\n",
			linesReturned: 2,
			moreLines: true,
		});
		expect(files_line_range_from_text(content, 5, 2)).toMatchObject({
			content: "e\n",
			linesReturned: 1,
			moreLines: false,
		});
		// Range entirely past the end → empty, no more lines.
		expect(files_line_range_from_text(content, 10, 2)).toMatchObject({
			content: "",
			linesReturned: 0,
			moreLines: false,
		});
		// No trailing newline: the final unterminated line still counts.
		expect(files_line_range_from_text("x\ny", 1, 5)).toMatchObject({
			content: "x\ny\n",
			linesReturned: 2,
			moreLines: false,
		});
	});

	test("files_line_range_from_text truncates a pathologically long line with a marker", () => {
		const longLine = "Z".repeat(50000);
		const content = `short\n${longLine}\nafter\n`;

		const result = files_line_range_from_text(content, 2, 1);
		expect(result.linesReturned).toBe(1);
		// Truncated to the display cap (8000), not the full 50000 chars.
		expect(result.content.length).toBeLessThan(50000);
		expect(result.content.startsWith("Z".repeat(8000))).toBe(true);
		expect(result.content).toContain("[line truncated to 8000 chars");
		// A normal-length line is returned untouched.
		expect(files_line_range_from_text(content, 1, 1).content).toBe("short\n");
	});

	test("files_tail_lines_from_text returns the last lines and truncates long ones", () => {
		expect(files_tail_lines_from_text("a\nb\nc\nd\n", 2)).toMatchObject({ content: "c\nd\n" });
		const out = files_tail_lines_from_text(`p\n${"Q".repeat(20000)}\n`, 1);
		expect(out.content).toContain("[line truncated to 8000 chars");
		expect(out.content.length).toBeLessThan(20000);
	});
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

/**
 * Round-trip markdown through the rich-text Yjs root the way the pending update action does.
 * The stored pending chunks are built from this rendered Markdown text, not the raw input text.
 */
function normalize_pending_update_markdown(markdown: string) {
	const yjsDoc = new YjsDoc();
	const updateResult = files_yjs_doc_update_from_text({
		rootKind: "rich_text",
		mut_yjsDoc: yjsDoc,
		text: markdown,
	});
	if (updateResult._nay) {
		throw new Error("Failed to normalize pending update markdown");
	}

	const normalizedMarkdown = files_yjs_doc_get_text({
		rootKind: "rich_text",
		yjsDoc,
	});
	if (normalizedMarkdown._nay) {
		throw new Error("Failed to read normalized pending update markdown");
	}

	return normalizedMarkdown._yay;
}

/**
 * Run the agent upsert flow the way the server does: stage the one text under a server-side
 * batch, then run the finishing internal action that carries only ids.
 */
async function upsert_pending_update_internal_for_test(
	t: ReturnType<typeof test_convex>,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		unstagedMarkdown: string;
	},
) {
	const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
	});
	if (batch._nay) {
		return batch;
	}

	const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		operationBatchId: batch._yay.operationBatchId,
		role: "unstaged",
		text: args.unstagedMarkdown,
	});
	if (staged._nay) {
		return staged;
	}

	return await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
		operationBatchId: batch._yay.operationBatchId,
	});
}

async function seed_paginated_bash_listing_fixture(ctx: MutationCtx) {
	const membership = await test_mocks_fill_db_with.membership(ctx);
	const docsFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: files_ROOT_ID,
		name: "docs",
		kind: "folder",
		path: "/docs",
		treePath: "/docs/",
		pathDepth: 1,
		updatedAt: 1,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "a.md",
		kind: "file",
		path: "/docs/a.md",
		treePath: "/docs/a.md",
		pathDepth: 2,
		lowercaseExtension: "md",
		updatedAt: 2,
		contentType: "text/markdown;charset=utf-8",
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "b.md",
		kind: "file",
		path: "/docs/b.md",
		treePath: "/docs/b.md",
		pathDepth: 2,
		lowercaseExtension: "md",
		updatedAt: 3,
	});
	const nestedFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "nested",
		kind: "folder",
		path: "/docs/nested",
		treePath: "/docs/nested/",
		pathDepth: 2,
		updatedAt: 4,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: nestedFolderId,
		name: "c.md",
		kind: "file",
		path: "/docs/nested/c.md",
		treePath: "/docs/nested/c.md",
		pathDepth: 3,
		lowercaseExtension: "md",
		updatedAt: 5,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "z-archived.md",
		kind: "file",
		path: "/docs/z-archived.md",
		treePath: "/docs/z-archived.md",
		pathDepth: 2,
		lowercaseExtension: "md",
		archiveOperationId: "archive-operation-test",
		updatedAt: 6,
	});
	const siblingPrefixFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: files_ROOT_ID,
		name: "docs-archive",
		kind: "folder",
		path: "/docs-archive",
		treePath: "/docs-archive/",
		pathDepth: 1,
		updatedAt: 7,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: siblingPrefixFolderId,
		name: "outside.md",
		kind: "file",
		path: "/docs-archive/outside.md",
		treePath: "/docs-archive/outside.md",
		pathDepth: 2,
		lowercaseExtension: "md",
		updatedAt: 8,
	});

	return { ...membership, docsFolderId };
}

describe("paginated bash listing queries", () => {
	test("list_tree returns active and archived nodes in treePath order", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const treeNodesList = await asUser.query(api.files_nodes.list_tree, {
			membershipId: db.membershipId,
		});

		expect(treeNodesList.map((item) => item.path)).toEqual([
			"/docs-archive",
			"/docs-archive/outside.md",
			"/docs",
			"/docs/a.md",
			"/docs/b.md",
			"/docs/nested",
			"/docs/nested/c.md",
			"/docs/z-archived.md",
		]);
		expect(treeNodesList.map((item) => item.archiveOperationId)).toContain("archive-operation-test");
	});

	test("paginates direct children without descendants or archived nodes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 2,
			cursor: null,
			orderBy: "name",
		});
		const secondPage = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 2,
			cursor: firstPage.continueCursor,
			orderBy: "name",
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

		const ascending = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			orderBy: "name",
			order: "asc",
		});
		const descending = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			orderBy: "name",
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

	test("paginates direct children by parent id in updatedAt order", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const descending = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			orderBy: "updatedAt",
		});
		const ascending = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			orderBy: "updatedAt",
			order: "asc",
		});

		expect(descending.items.map((item) => item.path)).toEqual(["/docs/nested", "/docs/b.md", "/docs/a.md"]);
		expect(descending.items.map((item) => item.updatedAt)).toEqual([4, 3, 2]);
		expect(ascending.items.map((item) => item.path)).toEqual(["/docs/a.md", "/docs/b.md", "/docs/nested"]);
		expect(descending.items.map((item) => item.path)).not.toContain("/docs/nested/c.md");
		expect(descending.items.map((item) => item.path)).not.toContain("/docs/z-archived.md");
	});

	test("paginates a recursive subtree without sibling-prefix leakage", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 2,
			cursor: null,
		});
		const secondPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 10,
			cursor: firstPage.continueCursor,
		});
		const paths = [...firstPage.page, ...secondPage.page].map((item) => item.path);

		expect(firstPage.isDone).toBe(false);
		expect(new Set(paths).size).toBe(paths.length);
		expect(paths).toEqual(
			expect.arrayContaining(["/docs", "/docs/a.md", "/docs/b.md", "/docs/nested", "/docs/nested/c.md"]),
		);
		expect(paths).not.toContain("/docs/z-archived.md");
		expect(paths).not.toContain("/docs-archive");
		expect(paths).not.toContain("/docs-archive/outside.md");
	});

	test("paginates recursive subtrees in ascending and descending path order with metadata", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const ascending = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 10,
			cursor: null,
			order: "asc",
		});
		const descending = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 10,
			cursor: null,
			order: "desc",
		});

		expect(ascending.page.map((item) => item.path)).toEqual([
			"/docs",
			"/docs/a.md",
			"/docs/b.md",
			"/docs/nested",
			"/docs/nested/c.md",
		]);
		expect(descending.page.map((item) => item.path)).toEqual([
			"/docs/nested/c.md",
			"/docs/nested",
			"/docs/b.md",
			"/docs/a.md",
			"/docs",
		]);
		expect(ascending.page[0]).toMatchObject({
			path: "/docs",
			kind: "folder",
			updatedAt: 1,
			updatedBy: db.userId,
		});
	});

	test("filters recursive descendants by kind and depth before pagination", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const filesAtDepthOne = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 10,
			cursor: null,
			kind: "file",
			maxDepth: 1,
		});
		const foldersAtDepthOne = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 10,
			cursor: null,
			kind: "folder",
			minDepth: 1,
			maxDepth: 1,
		});

		expect(filesAtDepthOne.page.map((item) => item.path)).toEqual(["/docs/a.md", "/docs/b.md"]);
		expect(foldersAtDepthOne.page.map((item) => item.path)).toEqual(["/docs/nested"]);
		expect(filesAtDepthOne.page.map((item) => item.path)).not.toContain("/docs/nested/c.md");
	});

	test("paginates extension-filtered recursive descendants through the extension index", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			kind: "file",
			lowercaseExtension: "md",
			numItems: 1,
			cursor: null,
			maxDepth: 1,
		});
		const secondPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			kind: "file",
			lowercaseExtension: "md",
			numItems: 10,
			cursor: firstPage.continueCursor,
			maxDepth: 1,
		});
		const paths = [...firstPage.page, ...secondPage.page].map((item) => item.path);

		expect(firstPage.isDone).toBe(false);
		expect(paths).toEqual(["/docs/a.md", "/docs/b.md"]);
		expect(paths).not.toContain("/docs/nested/c.md");
		expect(paths).not.toContain("/docs/z-archived.md");
		expect(paths).not.toContain("/docs-archive/outside.md");
	});

	test("paginates folder subtrees without sibling-prefix matches", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const result = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs/",
			numItems: 20,
			cursor: null,
		});
		const paths = result.page.map((item) => item.path);

		expect(result.isDone).toBe(true);
		expect(paths).toEqual(expect.arrayContaining(["/docs", "/docs/a.md", "/docs/nested/c.md"]));
		expect(paths).not.toContain("/docs-archive");
		expect(paths).not.toContain("/docs-archive/outside.md");
		expect(paths).not.toContain("/docs/z-archived.md");
	});

	test("filters folder subtrees by kind before pagination", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const result = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 20,
			cursor: null,
			kind: "file",
		});
		const paths = result.page.map((item) => item.path);

		expect(paths).toEqual(expect.arrayContaining(["/docs/a.md", "/docs/b.md", "/docs/nested/c.md"]));
		expect(paths).not.toContain("/docs");
		expect(paths).not.toContain("/docs/nested");
	});

	test("returns no docs when a folder subtree scan receives a file path", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs/a.md",
			numItems: 1,
			cursor: null,
		});
		const secondPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs/a.md",
			numItems: 1,
			cursor: firstPage.continueCursor,
		});

		expect(firstPage.page).toEqual([]);
		expect(firstPage.isDone).toBe(true);
		expect(secondPage.page).toEqual([]);
		expect(secondPage.isDone).toBe(true);
	});

	test("list_children returns workspace recency newest-first and paginates without gaps", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const desc = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			numItems: 50,
			cursor: null,
			orderBy: "updatedAt",
		});
		const asc = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			numItems: 50,
			cursor: null,
			orderBy: "updatedAt",
			order: "asc",
		});

		// Newest-first, archived node (updatedAt 6) excluded.
		expect(desc.items[0]?.path).toBe("/docs-archive/outside.md");
		expect(desc.items.map((item) => item.updatedAt)).toEqual([8, 7, 5, 4, 3, 2, 1]);
		expect(desc.items.map((item) => item.path)).not.toContain("/docs/z-archived.md");
		expect(asc.items[0]?.path).toBe("/docs");
		expect(asc.items.map((item) => item.updatedAt)).toEqual([1, 2, 3, 4, 5, 7, 8]);

		// Full multi-page cursor walk: no gaps, no dupes, terminal isDone.
		const seen: string[] = [];
		let cursor: string | null = null;
		let done = false;
		for (let page = 0; page < 20 && !done; page++) {
			// Explicit type: `cursor` is both an input and derived from the output, which
			// otherwise trips TS circular inference on the query result.
			const result: { items: Array<{ path: string }>; continueCursor: string; isDone: boolean } = await asUser.query(
				internal.files_nodes.list_children,
				{
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					visibilityUserId: db.userId,
					numItems: 3,
					cursor,
					orderBy: "updatedAt",
				},
			);
			seen.push(...result.items.map((item) => item.path));
			cursor = result.continueCursor;
			done = result.isDone;
		}
		expect(done).toBe(true);
		expect(new Set(seen).size).toBe(seen.length);
		expect([...seen].sort()).toEqual(desc.items.map((item) => item.path).sort());
	});

	test("list_children returns empty done pages for unsupported or invalid scopes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const workspaceNameOrder = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			numItems: 10,
			cursor: null,
			orderBy: "name",
		});
		const invalidParent = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: "GITHUB",
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			orderBy: "name",
		});

		expect(workspaceNameOrder).toEqual({ items: [], continueCursor: "", isDone: true });
		expect(invalidParent).toEqual({ items: [], continueCursor: "", isDone: true });
	});

	test("get_by_path resolves active paths and excludes archived or root paths", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const fileNode = await asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: "/docs/a.md",
		});
		const archived = await asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: "/docs/z-archived.md",
		});
		const root = await asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: "/",
		});

		expect(fileNode).toMatchObject({ path: "/docs/a.md", kind: "file" });
		expect(archived).toBeNull();
		expect(root).toBeNull();
	});
});

test("generated sibling file is visible in the tree query", async () => {
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
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			kind: "file" as const,
		};
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf",
			path: "/report.pdf",
			treePath: "/report.pdf",
		});
		const markdownNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf.md",
			path: "/report.pdf.md",
			treePath: "/report.pdf.md",
		});

		return { sourceNodeId, markdownNodeId };
	});

	const treeNodesList = await asUser.query(api.files_nodes.list_tree, {
		membershipId: db.membershipId,
	});

	const treeNodeIds = treeNodesList.map((fileNode) => fileNode._id);
	expect(treeNodeIds).toContain(sourceNodeId);
	expect(treeNodeIds).toContain(markdownNodeId);
	expect(treeNodesList.map((fileNode) => fileNode.path)).toEqual(
		expect.arrayContaining(["/report.pdf", "/report.pdf.md"]),
	);
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
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: root1Path,
		}),
		asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: child1Path,
		}),
		asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
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
		external_id: db.userId,
		name: "Test User",
	});

	const renamedRootName = "renamed_root";
	await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		path: renamedRootName,
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
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			name: "report.pdf",
			kind: "file",
			path: "/report.pdf",
			treePath: "/report.pdf",
			// Every production producer fills the indexed extension from the name; the rename
			// rule reads it, so the fixture must carry it too.
			lowercaseExtension: "pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			name: "report.pdf.md",
			kind: "file",
			path: "/report.pdf.md",
			treePath: "/report.pdf.md",
			lowercaseExtension: "md",
		});

		return { sourceNodeId, generatedNodeId };
	});

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: sourceNodeId,
		path: "renamed.pdf",
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
		external_id: db.userId,
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
		path: "received",
	});
	if (targetFolder._nay) {
		throw new Error(targetFolder._nay.message);
	}
	const { sourceNodeId, generatedNodeId } = await t.run(async (ctx) => {
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "report.pdf",
			kind: "file",
			path: "/report.pdf",
			treePath: "/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "report.pdf.md",
			kind: "file",
			path: "/report.pdf.md",
			treePath: "/report.pdf.md",
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

test("home file can be renamed and moved like any file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const homeNodeId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedAt: Date.now(),
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "README.md",
			kind: "file",
			path: "/README.md",
			treePath: "/README.md",
			pathDepth: 1,
			lowercaseExtension: "md",
			archiveOperationId: undefined,
		}),
	);

	await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: homeNodeId,
		path: "renamed-home.md",
	});

	await t.run(async (ctx) => {
		const homeFileNode = await ctx.db.get("files_nodes", homeNodeId);
		expect(homeFileNode?.name).toBe("renamed-home.md");
		expect(homeFileNode?.path).toBe("/renamed-home.md");
	});

	await asUser.mutation(api.files_nodes.move_nodes, {
		itemIds: [homeNodeId],
		targetParentId: db.files.file_root_1._id,
		membershipId: db.membershipId,
	});

	await t.run(async (ctx) => {
		const homeFileNode = await ctx.db.get("files_nodes", homeNodeId);
		expect(homeFileNode?.name).toBe("renamed-home.md");
		expect(homeFileNode?.path).toBe(`/${db.files.file_root_1.name}/renamed-home.md`);
		expect(homeFileNode?.parentId).toBe(db.files.file_root_1._id);
	});
});

test("home file can be archived like any file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const homeNodeId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedAt: Date.now(),
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "README.md",
			kind: "file",
			path: "/README.md",
			treePath: "/README.md",
			pathDepth: 1,
			lowercaseExtension: "md",
			archiveOperationId: undefined,
		}),
	);

	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [homeNodeId],
	});
	if (archived._nay) {
		throw new Error(archived._nay.message);
	}

	await t.run(async (ctx) => {
		const homeFileNode = await ctx.db.get("files_nodes", homeNodeId);
		expect(homeFileNode?.archiveOperationId).toBeDefined();
	});
});

test("create_folder_node rejects duplicate active path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const duplicateCreation = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: files_ROOT_ID,
		path: db.files.file_root_1.name,
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
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "notes",
			kind: "file",
			path: "/notes",
			treePath: "/notes",
		}),
	);

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "notes",
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
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "notes",
			kind: "file",
			path: "/notes",
			treePath: "/notes",
		}),
	);

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "notes/child",
	});

	if (result._yay) {
		throw new Error("Expected folder creation to fail when an intermediate path is a file");
	}
	expect(result._nay.message).toBe("This folder already exists.");

	await t.run(async (ctx) => {
		const existingFile = await ctx.db.get("files_nodes", fileNodeId);
		const child = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
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
		external_id: db.userId,
		name: "Test User",
	});

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: `${db.files.file_root_1.name}/new-child`,
	});

	if (result._nay) {
		throw new Error("Expected create_folder_node to reuse the existing intermediate folder", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", result._yay.nodeId);
		const rootFolders = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("parentId", files_ROOT_ID)
					.eq("name", db.files.file_root_1.name)
					.eq("archiveOperationId", undefined),
			)
			.collect()
			.then((fileNodes) => fileNodes.filter((fileNode) => fileNode.kind === "folder"));

		expect(folderFileNode).toMatchObject({
			name: "new-child",
			path: `/${db.files.file_root_1.name}/new-child`,
			parentId: db.files.file_root_1._id,
			kind: "folder",
		});
		expect(rootFolders).toHaveLength(1);
		expect(rootFolders[0]?._id).toBe(db.files.file_root_1._id);
	});
});

test("create_text_node preserves caller-provided file names", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "extensionless-create-file",
	});
	if (createdFile._nay) {
		throw new Error("Expected create_text_node to preserve caller-provided file name", {
			cause: createdFile._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		expect(fileNode?.name).toBe("extensionless-create-file");
		expect(fileNode?.path).toBe("/extensionless-create-file");
	});
});

test("create_text_node stores Markdown file properties", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "properties.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		const asset = fileNode?.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
		const assetKinds = (await ctx.db.query("files_r2_assets").collect()).map((doc) => doc.kind).sort();
		return { fileNode, asset, assetKinds };
	});
	expect(saved.fileNode).toMatchObject({
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		contentType: "text/markdown;charset=utf-8",
		assetId: saved.asset?._id,
	});
	// Editable files have no content asset row: the node points at its first version snapshot.
	expect(saved.asset).toMatchObject({
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		kind: "content_snapshot",
		r2Bucket: "test-files-bucket",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.assetKinds).toEqual(["content_snapshot", "yjs_snapshot"]);
	expect(saved.asset?.r2Key).toBe(
		`organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.asset?._id}`,
	);
});

test("create_text_node seeds initial Yjs content on the server", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial Content User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "server-initial.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!fileNode?.assetId || !fileNode.yjsLastSequenceId || !fileNode.yjsSnapshotId) {
			throw new Error("Expected server-seeded Markdown node docs");
		}

		const [asset, lastSequence, yjsSnapshot, yjsUpdates, textChunks, plainTextChunks] = await Promise.all([
			ctx.db.get("files_r2_assets", fileNode.assetId),
			ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId),
			ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId),
			ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", createdFile._yay.nodeId),
				)
				.order("asc")
				.collect(),
			ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", createdFile._yay.nodeId),
				)
				.collect(),
			ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", createdFile._yay.nodeId),
				)
				.collect(),
		]);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const stats = fileNode.statsId ? await ctx.db.get("file_stats", fileNode.statsId) : null;

		return {
			fileNode,
			asset,
			lastSequence,
			yjsSnapshot,
			yjsSnapshotAsset,
			yjsUpdates,
			textChunks,
			plainTextChunks,
			stats,
		};
	});

	expect(saved.fileNode.contentType).toBe("text/markdown;charset=utf-8");
	expect(saved.asset).toMatchObject({
		kind: "content_snapshot",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.lastSequence?.lastSequence).toBe(0);
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		kind: "yjs_snapshot",
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.textChunks.length).toBeGreaterThan(0);
	expect(saved.textChunks.every((chunk) => chunk.yjsSequence === 0)).toBe(true);
	expect(saved.plainTextChunks.length).toBe(saved.textChunks.length);
	expect(saved.plainTextChunks.every((chunk) => chunk.yjsSequence === 0)).toBe(true);
	expect(saved.stats).toMatchObject({
		lineCount: 2,
		wordCount: 9,
		charCount: files_INITIAL_CONTENT.length,
	});
});

test("create_text_node writes server-seeded initial content to R2", async () => {
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

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "server-initial-materialized.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!fileNode?.assetId || !fileNode.yjsSnapshotId) {
			throw new Error("Expected materialized server-seeded file docs");
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId),
			)
			.collect();
		const versionSnapshot = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId)
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

	// Editable files do not store their current content in R2: only the Yjs snapshot and the
	// version snapshot are uploaded, and the node points at the version snapshot.
	expect(saved.asset).toMatchObject({
		kind: "content_snapshot",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.asset?._id).toBe(saved.versionSnapshot?.assetId);
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.yjsSnapshotAsset?._id}`,
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.versionSnapshot?.fileNodeId).toBe(createdFile._yay.nodeId);
	expect(saved.versionSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.versionSnapshotAsset?._id}`,
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	const versionSnapshotR2Key = saved.versionSnapshotAsset?.r2Key;
	const yjsSnapshotR2Key = saved.yjsSnapshotAsset?.r2Key;
	if (!versionSnapshotR2Key || !yjsSnapshotR2Key) {
		throw new Error("Expected version and Yjs snapshot R2 keys");
	}
	expect(r2Writes.get(versionSnapshotR2Key)).toBe(files_INITIAL_CONTENT);
	expect(r2Writes.has(yjsSnapshotR2Key)).toBe(true);
});

test("create_text_node does not publish a file node when initial R2 writes fail", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial R2 Failure User",
	});
	const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
	let releaseSecondPut: (() => void) | undefined;
	const secondPutBlocked = new Promise<void>((resolve) => {
		releaseSecondPut = resolve;
	});
	let announceSecondPut: (() => void) | undefined;
	const secondPutStarted = new Promise<void>((resolve) => {
		announceSecondPut = resolve;
	});
	let putCount = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			putCount += 1;
			if (putCount === 1) {
				return new Response(null, { status: 500 });
			}
			announceSecondPut?.();
			await secondPutBlocked;
			return new Response(null, { status: 200 });
		}),
	);

	const creatingFile = asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "broken.md",
	});
	await secondPutStarted;
	// Give an early-rejecting Promise.all path time to start cleanup while its sibling PUT is
	// still blocked. The fixed path waits for both results, so both asset docs remain owned here.
	await new Promise((resolve) => setTimeout(resolve, 50));
	const preparedAssetIds = await t.run(async (ctx) =>
		(await ctx.db.query("files_r2_assets").collect()).map((asset) => asset._id),
	);
	expect(preparedAssetIds).toHaveLength(2);
	expect(await read_deletion_jobs(t)).toEqual([]);
	expect(deleteObjectSpy).not.toHaveBeenCalled();

	releaseSecondPut?.();
	const createdFile = await creatingFile;

	expect(createdFile._nay?.message).toBe("Failed to create file");
	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("path", "/broken.md")
					.eq("archiveOperationId", undefined),
			)
			.first();
		const assets = await ctx.db.query("files_r2_assets").collect();

		return { assets, fileNode };
	});
	expect(saved.fileNode).toBeNull();
	expect(saved.assets).toHaveLength(0);
	expect(deleteObjectSpy).not.toHaveBeenCalled();
	const jobs = await read_deletion_jobs(t);
	expect(jobs.map((job) => job.reason)).toEqual(["failed_create", "failed_create"]);
	expect(jobs.map((job) => job.r2Key).sort()).toEqual(expected_ledger_keys(db, preparedAssetIds));
});

test("create_text_node cleans up R2 objects when initial metadata sync fails", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial R2 Sync Failure User",
	});
	const r2Writes = test_setup_r2_capture();
	vi.spyOn(R2.prototype, "syncMetadata").mockRejectedValueOnce(new Error("sync failed"));
	const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "sync-failure.md",
	});

	expect(createdFile._nay?.message).toBe("Failed to create file");
	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("path", "/sync-failure.md")
					.eq("archiveOperationId", undefined),
			)
			.first();
		const assets = await ctx.db.query("files_r2_assets").collect();

		return { assets, fileNode };
	});
	expect(saved.fileNode).toBeNull();
	expect(saved.assets).toHaveLength(0);
	expect(deleteObjectSpy).not.toHaveBeenCalled();
	const jobs = await read_deletion_jobs(t);
	expect(jobs.map((job) => job.reason)).toEqual(["failed_create", "failed_create"]);
	expect(jobs.map((job) => job.r2Key).sort()).toEqual(Array.from(r2Writes.keys()).sort());
});

test("create_text_node refuses a duplicate path at capture, before any upload", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Duplicate R2 Cleanup User",
	});
	const r2Writes = test_setup_r2_capture();
	const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockImplementation(async (_ctx, key) => {
		r2Writes.delete(key);
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "duplicate.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const beforeDuplicate = await t.run(async (ctx) => {
		return {
			assetCount: (await ctx.db.query("files_r2_assets").collect()).length,
			fileCount: (
				await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("path", "/duplicate.md")
							.eq("archiveOperationId", undefined),
					)
					.collect()
			).length,
		};
	});
	const baselineKeys = Array.from(r2Writes.keys()).sort();

	const duplicate = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "duplicate.md",
	});

	expect(duplicate._nay?.message).toBe("This file already exists.");
	const afterDuplicate = await t.run(async (ctx) => {
		return {
			assetCount: (await ctx.db.query("files_r2_assets").collect()).length,
			fileCount: (
				await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("path", "/duplicate.md")
							.eq("archiveOperationId", undefined),
					)
					.collect()
			).length,
		};
	});

	expect(afterDuplicate).toEqual(beforeDuplicate);
	expect(Array.from(r2Writes.keys()).sort()).toEqual(baselineKeys);
	// The preflight sees the occupied target before any asset doc or R2 upload exists.
	// A separate test covers a target that appears after the uploads.
	expect(deleteObjectSpy).not.toHaveBeenCalled();
	expect(await read_deletion_jobs(t)).toEqual([]);
});

test("create_folder_node creates missing folders for nested folder paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: files_ROOT_ID,
		path: "invalid/name",
		membershipId: db.membershipId,
	});

	if (result._nay) {
		throw new Error("Expected create_folder_node to create the nested folder path", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", result._yay.nodeId);
		expect(folderFileNode?.name).toBe("name");
		expect(folderFileNode?.path).toBe("/invalid/name");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("path", "/invalid"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(folderFileNode?.parentId).toBe(parentFolder?._id);
	});
});

test("create_text_node creates missing folders for nested file paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const result = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "notes/workspaces/plan.md",
	});
	if (result._nay) {
		throw new Error("Expected create_text_node to create the nested file path", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", result._yay.nodeId);
		expect(fileNode?.name).toBe("plan.md");
		expect(fileNode?.path).toBe("/notes/workspaces/plan.md");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("path", "/notes/workspaces"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(fileNode?.parentId).toBe(parentFolder?._id);
	});
});

test("archived nodes can share path with a new active node", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const duplicateName = "archived-duplicate-allowed.md";

	const createdFile = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
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

	const recreatedFile = await asUser.action(api.files_nodes_content.create_text_node, {
		parentId: files_ROOT_ID,
		path: duplicateName,
		membershipId: db.membershipId,
	});
	if (recreatedFile._nay) {
		throw new Error("Expected recreated file creation to succeed");
	}

	await t.run(async (ctx) => {
		const path = `/${duplicateName}`;
		const filesAtPath = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("path", path),
			)
			.collect();

		expect(filesAtPath).toHaveLength(2);
		expect(filesAtPath.filter((fileNode) => fileNode.archiveOperationId !== undefined)).toHaveLength(1);
		expect(filesAtPath.filter((fileNode) => fileNode.archiveOperationId === undefined)).toHaveLength(1);
	});
});

test("create_file_by_path can reuse an existing active file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const path = "/existing-by-path.md";

	const createdFile = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
	});
	if (createdFile._nay) {
		throw new Error("Expected initial file creation to succeed");
	}
	if (!createdFile._yay.created) {
		throw new Error("Expected initial file creation to create a node");
	}

	const reusedFile = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
	});
	if (reusedFile._nay) {
		throw new Error("Expected existing file reuse to succeed");
	}
	if (reusedFile._yay.created) {
		throw new Error("Expected existing file reuse not to create a node");
	}

	expect(reusedFile._yay.nodeId).toBe(createdFile._yay.nodeId);
	expect(reusedFile._yay.created).toBe(false);
	// No folder was created in either call: a root-level create and a reuse both report none.
	expect(createdFile._yay.createdAncestorIds).toEqual([]);
	expect(reusedFile._yay.createdAncestorIds).toEqual([]);
});

test("create_file_by_path reports created ancestor folders deepest-first", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

	const created = await t.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/r12a/deep/x.md",
	});
	if (created._nay) {
		throw new Error(created._nay.message);
	}
	if (!created._yay.created) {
		throw new Error("Expected create_file_by_path to create a fresh node");
	}
	expect(created._yay.createdAncestorIds).toHaveLength(2);

	const [deepAncestorId, shallowAncestorId] = created._yay.createdAncestorIds;
	if (!deepAncestorId || !shallowAncestorId) {
		throw new Error("Expected two created ancestor folder ids");
	}
	await t.run(async (ctx) => {
		const deepFolder = await ctx.db.get("files_nodes", deepAncestorId);
		const shallowFolder = await ctx.db.get("files_nodes", shallowAncestorId);
		expect(deepFolder?.path).toBe("/r12a/deep");
		expect(deepFolder?.kind).toBe("folder");
		expect(shallowFolder?.path).toBe("/r12a");
		expect(shallowFolder?.kind).toBe("folder");
	});
});

describe("files_nodes.remove_eager_created_node_if_safe", () => {
	async function create_eager_node(t: ReturnType<typeof test_convex>, path: string) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		if (!created._yay.created || created._yay.createdCommittedSequence === undefined) {
			throw new Error("Expected create_file_by_path to create a fresh node");
		}
		return {
			db,
			nodeId: created._yay.nodeId,
			eagerCreatedCommittedSequence: created._yay.createdCommittedSequence,
			createdAncestorIds: created._yay.createdAncestorIds,
		};
	}

	test("removes an untouched eager node with no pending row", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, nodeId, eagerCreatedCommittedSequence } = await create_eager_node(t, "/eager-cleanup-untouched.md");

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
		});
		expect(removed._yay.removed).toBe(true);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).toBeNull();
		});
	});

	test("keeps the node when another user has a pending row on it", async () => {
		const t = test_convex();
		const { db, nodeId, eagerCreatedCommittedSequence } = await create_eager_node(t, "/eager-cleanup-other-user.md");

		// Another user drafts on the node before the compensation runs; a hard delete would
		// destroy their draft.
		const otherUserRowId = await t.run((ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: "other_user_eager_cleanup_guard",
				fileNodeId: nodeId,
				size: 0,
				updatedAt: Date.now(),
			}),
		);

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
		});
		expect(removed._yay.removed).toBe(false);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).not.toBeNull();
			expect(await ctx.db.get("files_pending_updates", otherUserRowId)).not.toBeNull();
		});
	});

	test("keeps a node whose committed content advanced since the eager create", async () => {
		const t = test_convex();
		const { db, nodeId, eagerCreatedCommittedSequence } = await create_eager_node(t, "/eager-cleanup-saved.md");

		// A real save advances the committed Yjs sequence past the creation-time stamp.
		const savedYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "# Saved by the user" });
		if ("_nay" in savedYjsDoc) {
			throw new Error(savedYjsDoc._nay.message);
		}
		await t.run((ctx) =>
			files_db_yjs_push_update(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				nodeId,
				rootKind: "rich_text",
				update: files_u8_to_array_buffer(encodeStateAsUpdate(savedYjsDoc)),
				sessionId: "eager-cleanup-saved-session",
				materializeImmediately: false,
			}),
		);

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
		});
		expect(removed._yay.removed).toBe(false);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).not.toBeNull();
		});
	});

	test("keeps a node whose committed metadata was written since the eager create", async () => {
		const t = test_convex();
		// Current code still hard-deletes, so the R2 mock must be in place or this proof dies in
		// cleanup instead of at the keep assertion below.
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, nodeId, eagerCreatedCommittedSequence } = await create_eager_node(t, "/eager-cleanup-metadata.md");

		// Metadata is a committed write that applies right away. It must stamp the node as a real
		// file the same way a content save does, or discarding the pending create wipes the map.
		const written = await t.mutation(internal.files_metadata.update_entries_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/eager-cleanup-metadata.md",
			set: [{ key: "created-by", value: "agent" }],
			remove: [],
		});
		if (written._nay) throw new Error(written._nay.message);

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
		});
		expect(removed._yay.removed).toBe(false);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).not.toBeNull();
		});
	});

	test("reports removed false without throwing when the node is missing", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, nodeId, eagerCreatedCommittedSequence } = await create_eager_node(t, "/eager-cleanup-missing.md");

		const firstRemoval = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
		});
		expect(firstRemoval._yay.removed).toBe(true);

		// A retry against the already-removed node stays benign for the compensation caller.
		const secondRemoval = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
		});
		expect(secondRemoval._yay.removed).toBe(false);
	});

	test("removes created ancestor folders together with the leaf", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, nodeId, eagerCreatedCommittedSequence, createdAncestorIds } = await create_eager_node(
			t,
			"/r12a/deep/x.md",
		);
		expect(createdAncestorIds).toHaveLength(2);

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
			createdAncestorIds,
		});
		expect(removed._yay).toEqual({ removed: true, ancestorsLeft: 0 });

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).toBeNull();
			for (const ancestorId of createdAncestorIds) {
				expect(await ctx.db.get("files_nodes", ancestorId)).toBeNull();
			}
		});
	});

	test("keeps an ancestor folder that gained another committed child", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, nodeId, eagerCreatedCommittedSequence, createdAncestorIds } = await create_eager_node(
			t,
			"/r12a/deep/x.md",
		);

		// A second committed file under /r12a makes that folder non-empty once the deep
		// branch is compensated away.
		const sibling = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/r12a/other.md",
		});
		if (sibling._nay) {
			throw new Error(sibling._nay.message);
		}

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
			createdAncestorIds,
		});
		expect(removed._yay).toEqual({ removed: true, ancestorsLeft: 1 });

		const [deepAncestorId, shallowAncestorId] = createdAncestorIds;
		if (!deepAncestorId || !shallowAncestorId) {
			throw new Error("Expected two created ancestor folder ids");
		}
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).toBeNull();
			expect(await ctx.db.get("files_nodes", deepAncestorId)).toBeNull();
			expect(await ctx.db.get("files_nodes", shallowAncestorId)).not.toBeNull();
		});
	});

	test("keeps an ancestor folder another user renamed since the create", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, nodeId, eagerCreatedCommittedSequence, createdAncestorIds } = await create_eager_node(
			t,
			"/r13f/deep/x.md",
		);
		const [deepAncestorId, shallowAncestorId] = createdAncestorIds;
		if (!deepAncestorId || !shallowAncestorId) {
			throw new Error("Expected two created ancestor folder ids");
		}

		// Another workspace member renames the created folder through the REAL rename_node
		// mutation, which stamps updatedBy; the compensation must not delete their rename.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_eager_ancestor_renamed_other",
			});
			const now = Date.now();
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: otherUserId,
				active: true,
				updatedAt: now,
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});
			return { otherUserId, otherMembershipId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const renamed = await asOtherUser.mutation(api.files_nodes.rename_node, {
			membershipId: other.otherMembershipId,
			nodeId: deepAncestorId,
			path: "deep-renamed",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
			createdAncestorIds,
		});
		expect(removed._yay).toEqual({ removed: true, ancestorsLeft: 2 });

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).toBeNull();
			const deepFolder = await ctx.db.get("files_nodes", deepAncestorId);
			expect(deepFolder?.path).toBe("/r13f/deep-renamed");
			expect(await ctx.db.get("files_nodes", shallowAncestorId)).not.toBeNull();
		});
	});

	test("keeps an ancestor folder referenced by a pending row", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, nodeId, eagerCreatedCommittedSequence, createdAncestorIds } = await create_eager_node(
			t,
			"/r13g/deep/x.md",
		);
		const [deepAncestorId, shallowAncestorId] = createdAncestorIds;
		if (!deepAncestorId || !shallowAncestorId) {
			throw new Error("Expected two created ancestor folder ids");
		}

		// A pending move of the created folder itself, proposed through the REAL move-upsert:
		// deleting the folder would orphan this row.
		const movedProposal = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: deepAncestorId,
			destParentId: files_ROOT_ID,
			destName: "deep-moved",
		});
		if (movedProposal._nay) {
			throw new Error(movedProposal._nay.message);
		}

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
			createdAncestorIds,
		});
		expect(removed._yay).toEqual({ removed: true, ancestorsLeft: 2 });

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).toBeNull();
			expect(await ctx.db.get("files_nodes", deepAncestorId)).not.toBeNull();
			const folderPendingRow = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", deepAncestorId))
				.first();
			expect(folderPendingRow).not.toBeNull();
			expect(await ctx.db.get("files_nodes", shallowAncestorId)).not.toBeNull();
		});
	});

	test("keeps an ancestor folder that is another user's pending move destination", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, nodeId, eagerCreatedCommittedSequence, createdAncestorIds } = await create_eager_node(
			t,
			"/r13h/deep/x.md",
		);
		const [deepAncestorId, shallowAncestorId] = createdAncestorIds;
		if (!deepAncestorId || !shallowAncestorId) {
			throw new Error("Expected two created ancestor folder ids");
		}

		// Another user proposes moving their own file INTO the created folder through the REAL
		// move-upsert: the row lives on their file, not on the folder, but its destination is
		// the folder and deleting it would break their Accept later.
		const otherUserId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_eager_move_dest_other" });
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});
			return userId;
		});
		const otherFile = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: otherUserId,
			path: "/move-dest-source.md",
		});
		if (otherFile._nay) {
			throw new Error(otherFile._nay.message);
		}
		const movedProposal = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: otherUserId,
			nodeId: otherFile._yay.nodeId,
			destParentId: deepAncestorId,
			destName: "move-dest-source.md",
		});
		if (movedProposal._nay) {
			throw new Error(movedProposal._nay.message);
		}

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
			createdAncestorIds,
		});
		expect(removed._yay).toEqual({ removed: true, ancestorsLeft: 2 });

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).toBeNull();
			expect(await ctx.db.get("files_nodes", deepAncestorId)).not.toBeNull();
			expect(await ctx.db.get("files_nodes", shallowAncestorId)).not.toBeNull();
			const otherRow = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", otherFile._yay.nodeId))
				.first();
			expect(otherRow?.pendingMove?.destParentId).toBe(deepAncestorId);
		});
	});

	test("keeps created ancestor folders when the leaf is unsafe to delete", async () => {
		const t = test_convex();
		const { db, nodeId, eagerCreatedCommittedSequence, createdAncestorIds } = await create_eager_node(
			t,
			"/r12b/deep/x.md",
		);

		// A real save advances the committed Yjs sequence past the creation-time stamp,
		// so the leaf gate blocks and no folder may be touched either.
		const savedYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "# Saved by the user" });
		if ("_nay" in savedYjsDoc) {
			throw new Error(savedYjsDoc._nay.message);
		}
		await t.run((ctx) =>
			files_db_yjs_push_update(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				nodeId,
				rootKind: "rich_text",
				update: files_u8_to_array_buffer(encodeStateAsUpdate(savedYjsDoc)),
				sessionId: "eager-cleanup-ancestors-saved-session",
				materializeImmediately: false,
			}),
		);

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
			createdAncestorIds,
		});
		expect(removed._yay).toEqual({ removed: false, ancestorsLeft: 2 });

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).not.toBeNull();
			for (const ancestorId of createdAncestorIds) {
				expect(await ctx.db.get("files_nodes", ancestorId)).not.toBeNull();
			}
		});
	});
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

		const created = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "lookup.md",
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

	test("returns null for a member without content.read", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "gated.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const allowed = await asUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: db.membershipId,
			path: "/gated.md",
		});
		expect(allowed?.nodeId).toBe(created._yay.nodeId);

		// Every permission check answers "yes" for the organization owner, so we give ownership to
		// somebody else and delete this user's role assignments. What is left is a member with no
		// `content.read`.
		await t.run(async (ctx) => {
			const otherOwnerId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.patch("organizations", db.organizationId, { ownerUserId: otherOwnerId });

			const roleAssignments = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user", (q) => q.eq("organizationId", db.organizationId))
				.collect();
			await Promise.all(
				roleAssignments
					.filter((assignment) => assignment.userId === db.userId)
					.map((assignment) => ctx.db.delete("access_control_role_assignments", assignment._id)),
			);
		});

		const denied = await asUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: db.membershipId,
			path: "/gated.md",
		});
		expect(denied).toBeNull();
	});

	test("resolves the path inside the membership tenant only", async () => {
		const t = test_convex();
		const first = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const second = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" }),
		);

		const asFirstUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: first.userId,
			name: "First User",
		});
		const asSecondUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: second.userId,
			name: "Second User",
		});

		const firstCreated = await asFirstUser.action(api.files_nodes_content.create_text_node, {
			membershipId: first.membershipId,
			parentId: files_ROOT_ID,
			path: "shared-name.md",
		});
		const secondCreated = await asSecondUser.action(api.files_nodes_content.create_text_node, {
			membershipId: second.membershipId,
			parentId: files_ROOT_ID,
			path: "shared-name.md",
		});
		if (firstCreated._nay || secondCreated._nay) {
			throw new Error(firstCreated._nay?.message ?? secondCreated._nay?.message);
		}

		const resolvedForFirst = await asFirstUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: first.membershipId,
			path: "/shared-name.md",
		});
		const resolvedForSecond = await asSecondUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: second.membershipId,
			path: "/shared-name.md",
		});

		expect(resolvedForFirst?.nodeId).toBe(firstCreated._yay.nodeId);
		expect(resolvedForSecond?.nodeId).toBe(secondCreated._yay.nodeId);
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
			const stats = source?.statsId ? await ctx.db.get("file_stats", source.statsId) : null;
			const [textChunks, plainTextChunks] = await Promise.all([
				ctx.db
					.query("files_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("fileNodeId", upload._yay.nodeId),
					)
					.collect(),
				ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("fileNodeId", upload._yay.nodeId),
					)
					.collect(),
			]);
			return { asset, source, stats, textChunks, plainTextChunks };
		});
		expect(docs.source).toMatchObject({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			name: "annual-report.pdf",
			kind: "file",
			contentType: "application/pdf",
			assetId: upload._yay.assetId,
		});
		expect(docs.source?.archiveOperationId).toBeUndefined();
		expect(docs.asset).toMatchObject({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "upload",
			createdBy: db.userId,
			r2Bucket: "test-files-bucket",
			size: 1234,
		});
		expect(docs.asset?.r2Key).toBeUndefined();
		expect(docs.stats).toMatchObject({
			lineCount: -1,
			wordCount: -1,
			charCount: -1,
		});
		expect(docs.textChunks).toEqual([]);
		expect(docs.plainTextChunks).toEqual([]);
		expect(generateUploadUrlSpy).toHaveBeenCalledWith(
			`organizations/${db.organizationId}/workspaces/${db.workspaceId}/upload-staging/${upload._yay.assetId}`,
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
			path: "annual-report.pdf",
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
							asset.organizationId === db.organizationId &&
							asset.workspaceId === db.workspaceId &&
							asset.kind === "upload",
					),
				);
			const uploadedSources = await ctx.db
				.query("files_nodes")
				.collect()
				.then((fileNodes) =>
					fileNodes.filter(
						(fileNode) =>
							fileNode.organizationId === db.organizationId &&
							fileNode.workspaceId === db.workspaceId &&
							fileNode.assetId,
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
				.then((fileNodes) =>
					fileNodes.filter(
						(fileNode) =>
							fileNode.organizationId === db.organizationId &&
							fileNode.workspaceId === db.workspaceId &&
							fileNode.assetId,
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
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content",
				r2Bucket: "test-files-bucket",
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/generated-test-asset`,
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			return await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "replace-me.pdf.md",
				kind: "file",
				path: "/replace-me.pdf.md",
				treePath: "/replace-me.pdf.md",
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
			`organizations/${db.organizationId}/workspaces/${db.workspaceId}/upload-staging/${replacement._yay.assetId}`,
		);
	});

	test("fail leaves the file holding the path alone and creates nothing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstUpload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "photo.png",
			contentType: "image/png",
			size: 1024,
		});
		if (firstUpload._nay) {
			throw new Error(firstUpload._nay.message);
		}

		const secondUpload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "photo.png",
			contentType: "image/png",
			size: 2048,
			onConflict: "fail",
		});

		expect(secondUpload._nay).toMatchObject({ message: files_UPLOAD_PATH_TAKEN_MESSAGE });
		const docs = await t.run(async (ctx) => {
			const firstSource = await ctx.db.get("files_nodes", firstUpload._yay.nodeId);
			const uploadAssets = await ctx.db
				.query("files_r2_assets")
				.collect()
				.then((assets) =>
					assets.filter(
						(asset) =>
							asset.organizationId === db.organizationId &&
							asset.workspaceId === db.workspaceId &&
							asset.kind === "upload",
					),
				);
			return { firstSource, uploadAssets };
		});
		// A document embedding the first upload keeps working: refusing must not archive it.
		expect(docs.firstSource?.archiveOperationId).toBeUndefined();
		expect(docs.uploadAssets).toHaveLength(1);
		expect(docs.uploadAssets[0]?._id).toBe(firstUpload._yay.assetId);
	});
});

describe("files_nodes.create_upload_nodes", () => {
	test("creates nested files with presigned urls and reuses folders across calls", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "docs/report.pdf", contentType: "application/pdf", size: 1234 },
				{ relativePath: "docs/img/logo.png", contentType: "image/png", size: 10 },
				{ relativePath: "docs/raw.bin", size: 5 },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}

		expect(imported._yay.skipped).toEqual([]);
		expect(imported._yay.created).toHaveLength(3);
		expect(imported._yay.created[0]).toMatchObject({
			relativePath: "docs/report.pdf",
			url: "https://r2.test/upload",
			headers: { "Content-Type": "application/pdf" },
		});
		expect(imported._yay.created[2]!.headers).toEqual({});

		const docs = await t.run(async (ctx) => {
			const report = await ctx.db.get("files_nodes", imported._yay.created[0]!.nodeId);
			const reportAsset = await ctx.db.get("files_r2_assets", imported._yay.created[0]!.assetId);
			const docsFolder = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/docs")
						.eq("archiveOperationId", undefined),
				)
				.first();
			const imgFolder = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/docs/img")
						.eq("archiveOperationId", undefined),
				)
				.first();
			return { report, reportAsset, docsFolder, imgFolder };
		});
		expect(docs.report).toMatchObject({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			path: "/docs/report.pdf",
			kind: "file",
			contentType: "application/pdf",
			assetId: imported._yay.created[0]!.assetId,
			createdBy: db.userId,
		});
		expect(docs.reportAsset).toMatchObject({
			kind: "upload",
			size: 1234,
			createdBy: db.userId,
		});
		// Unlike `data_import`, a browser import must run the standard R2 event pipeline, so
		// `processingWorkId` stays unset instead of being settled to null up front.
		expect(docs.reportAsset?.processingWorkId).toBeUndefined();
		expect(docs.docsFolder).toMatchObject({ kind: "folder" });
		expect(docs.imgFolder).toMatchObject({ kind: "folder" });
		expect(generateUploadUrlSpy).toHaveBeenCalledWith(
			`organizations/${db.organizationId}/workspaces/${db.workspaceId}/upload-staging/${imported._yay.created[0]!.assetId}`,
		);

		const second = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "docs/img/second.png", contentType: "image/png", size: 20 }],
		});
		if (second._nay) {
			throw new Error(second._nay.message);
		}
		expect(second._yay.created).toHaveLength(1);

		const docsFolders = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/docs")
						.eq("archiveOperationId", undefined),
				)
				.collect(),
		);
		expect(docsFolders).toHaveLength(1);
	});

	test("imports into a selected folder and prefixes every path with the parent's", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		// The first import creates the destination folder as an intermediate.
		const seeded = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "dest/seed.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (seeded._nay) {
			throw new Error(seeded._nay.message);
		}
		const destFolder = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/dest")
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
		if (!destFolder) {
			throw new Error("dest folder missing");
		}

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: destFolder._id,
			onConflict: "skip",
			items: [{ relativePath: "sub/child.pdf", contentType: "application/pdf", size: 2 }],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}
		expect(imported._yay.skipped).toEqual([]);
		const child = await t.run(async (ctx) => ctx.db.get("files_nodes", imported._yay.created[0]!.nodeId));
		expect(child).toMatchObject({ path: "/dest/sub/child.pdf", parentId: expect.anything() });

		// The conflict pre-check resolves paths against the same parent.
		const conflicts = await asUser.query(api.files_nodes.get_upload_conflicts, {
			membershipId: db.membershipId,
			parentId: destFolder._id,
			relativePaths: ["sub/child.pdf", "missing.pdf"],
		});
		expect(conflicts).toEqual([{ relativePath: "sub/child.pdf", kind: "file" }]);
	});

	test("accepts boundary sizes of zero and the exact upload cap", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "empty.pdf", contentType: "application/pdf", size: 0 },
				{ relativePath: "max.pdf", contentType: "application/pdf", size: files_MAX_UPLOADS_BYTES },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}
		expect(imported._yay.created).toHaveLength(2);
	});

	test("rejects a markdown leaf the markdown normalizer would rename, and accepts the normalized one", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		// `readme` is special-cased to uppercase, so the lowercase name is not a fixed point of
		// the normalizer and must fail the whole call. The client sends normalizer output, so a
		// real import carries `README.md` already.
		const lowercase = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "docs/readme.md", contentType: "text/markdown", size: 1 }],
		});
		expect(lowercase._nay).toMatchObject({
			message: "Path ends in an invalid file name",
			data: { path: "docs/readme.md" },
		});

		const normalized = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "docs/README.md", contentType: "text/markdown", size: 1 }],
		});
		if (normalized._nay) {
			throw new Error(normalized._nay.message);
		}
		expect(normalized._yay.created).toHaveLength(1);
	});

	test("rejects a malformed path and creates nothing, including the valid items", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const cases = [
			{ relativePath: "/abs.pdf", message: "Path must be relative and normalized" },
			{ relativePath: "a//b.pdf", message: "Path must be relative and normalized" },
			{ relativePath: "a.pdf/", message: "Path must be relative and normalized" },
			{ relativePath: "../up.pdf", message: "Path contains an invalid folder name" },
			{ relativePath: "a\\b.pdf", message: "Path ends in an invalid file name" },
		];
		for (const badCase of cases) {
			const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				onConflict: "skip",
				items: [
					{ relativePath: "fine.pdf", contentType: "application/pdf", size: 1 },
					{ relativePath: badCase.relativePath, contentType: "application/pdf", size: 1 },
				],
			});
			expect(imported._nay).toMatchObject({ message: badCase.message, data: { path: badCase.relativePath } });
		}

		// The valid item in each batch must not survive the refused call.
		const docs = await t.run(async (ctx) => {
			const uploadedSources = await ctx.db
				.query("files_nodes")
				.collect()
				.then((fileNodes) =>
					fileNodes.filter(
						(fileNode) =>
							fileNode.organizationId === db.organizationId &&
							fileNode.workspaceId === db.workspaceId &&
							fileNode.assetId,
					),
				);
			const uploadAssets = await ctx.db
				.query("files_r2_assets")
				.collect()
				.then((assets) =>
					assets.filter(
						(asset) =>
							asset.organizationId === db.organizationId &&
							asset.workspaceId === db.workspaceId &&
							asset.kind === "upload",
					),
				);
			return { uploadedSources, uploadAssets };
		});
		expect(docs.uploadedSources).toHaveLength(0);
		expect(docs.uploadAssets).toHaveLength(0);
	});

	test("skip mode reports an existing file as a conflict and keeps it", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "dup.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}

		const again = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "dup.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "fresh.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		if (again._nay) {
			throw new Error(again._nay.message);
		}

		expect(again._yay.skipped).toEqual([{ relativePath: "dup.pdf", reason: "conflict" }]);
		expect(again._yay.created).toHaveLength(1);
		expect(again._yay.created[0]).toMatchObject({ relativePath: "fresh.pdf" });

		const original = await t.run(async (ctx) => await ctx.db.get("files_nodes", first._yay.created[0]!.nodeId));
		expect(original?.archiveOperationId).toBeUndefined();
	});

	test("replace mode archives the existing file and creates a new node", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "dup.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}

		const replaced = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "replace",
			items: [{ relativePath: "dup.pdf", contentType: "application/pdf", size: 2 }],
		});
		if (replaced._nay) {
			throw new Error(replaced._nay.message);
		}

		expect(replaced._yay.skipped).toEqual([]);
		expect(replaced._yay.created).toHaveLength(1);
		expect(replaced._yay.created[0]!.assetId).not.toBe(first._yay.created[0]!.assetId);

		const docs = await t.run(async (ctx) => {
			const oldSource = await ctx.db.get("files_nodes", first._yay.created[0]!.nodeId);
			const newSource = await ctx.db.get("files_nodes", replaced._yay.created[0]!.nodeId);
			return { oldSource, newSource };
		});
		expect(docs.oldSource?.archiveOperationId).toEqual(expect.any(String));
		expect(docs.newSource).toMatchObject({
			path: "/dup.pdf",
			assetId: replaced._yay.created[0]!.assetId,
		});
		expect(docs.newSource?.archiveOperationId).toBeUndefined();
	});

	test("skips paths blocked by a folder at the target or a file on the way", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "blocked.pdf",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		const ancestorFile = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "ancestor.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (ancestorFile._nay) {
			throw new Error(ancestorFile._nay.message);
		}

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "replace",
			items: [
				{ relativePath: "blocked.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "ancestor.pdf/child.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}

		// Both shapes are skips even in replace mode: a folder is never archived by an import, and
		// a file on the way can never become a folder.
		expect(imported._yay.created).toEqual([]);
		expect(imported._yay.skipped).toEqual([
			{ relativePath: "blocked.pdf", reason: "path_blocked" },
			{ relativePath: "ancestor.pdf/child.pdf", reason: "path_blocked" },
		]);
	});

	test("a file and a folder chain on the same batch path resolve to one file and one skip", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "x.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "x.pdf/y.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}

		expect(imported._yay.created).toHaveLength(1);
		expect(imported._yay.created[0]).toMatchObject({ relativePath: "x.pdf" });
		expect(imported._yay.skipped).toEqual([{ relativePath: "x.pdf/y.pdf", reason: "path_blocked" }]);

		// The skipped item must not leave an orphan asset doc behind.
		const uploadAssets = await t.run(async (ctx) =>
			ctx.db
				.query("files_r2_assets")
				.collect()
				.then((assets) =>
					assets.filter(
						(asset) =>
							asset.organizationId === db.organizationId &&
							asset.workspaceId === db.workspaceId &&
							asset.kind === "upload",
					),
				),
		);
		expect(uploadAssets).toHaveLength(1);
	});

	test("duplicates, empty batches, oversize items, and oversized batches fail the whole call", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const empty = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [],
		});
		expect(empty._nay).toMatchObject({ message: "No files to import" });

		const tooMany = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: Array.from({ length: 51 }, (_, index) => ({ relativePath: `f${index}.pdf`, size: 1 })),
		});
		expect(tooMany._nay).toMatchObject({ message: "Too many files" });

		const duplicated = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "a.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "a.pdf", contentType: "application/pdf", size: 2 },
			],
		});
		expect(duplicated._nay).toMatchObject({ message: "Duplicate path in batch", data: { path: "a.pdf" } });

		const oversized = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "big.pdf", contentType: "application/pdf", size: files_MAX_UPLOADS_BYTES + 1 }],
		});
		expect(oversized._nay).toMatchObject({ message: "File too large", data: { path: "big.pdf" } });

		// `v.number()` accepts NaN, so the size guard must catch it along with negatives.
		const nanSize = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "nan.pdf", contentType: "application/pdf", size: Number.NaN }],
		});
		expect(nanSize._nay).toMatchObject({ message: "Invalid file size", data: { path: "nan.pdf" } });

		const negativeSize = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "negative.pdf", contentType: "application/pdf", size: -1 }],
		});
		expect(negativeSize._nay).toMatchObject({ message: "Invalid file size", data: { path: "negative.pdf" } });

		const uploadedSources = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.collect()
				.then((fileNodes) =>
					fileNodes.filter(
						(fileNode) =>
							fileNode.organizationId === db.organizationId &&
							fileNode.workspaceId === db.workspaceId &&
							fileNode.assetId,
					),
				),
		);
		expect(uploadedSources).toHaveLength(0);
	});

	test("charges the bulk import bucket one token per file", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const checkSpy = vi.spyOn(RateLimiter.prototype, "check");
		const limitSpy = vi.spyOn(RateLimiter.prototype, "limit");

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "a.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "b.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "c.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}

		expect(checkSpy).toHaveBeenCalledWith(
			expect.anything(),
			"files_bulk_import",
			expect.objectContaining({ count: 3 }),
		);
		expect(limitSpy).toHaveBeenCalledWith(
			expect.anything(),
			"files_bulk_import",
			expect.objectContaining({ count: 3 }),
		);
		expect(limitSpy).toHaveBeenCalledWith(
			expect.anything(),
			"files_tree_write",
			expect.objectContaining({ key: db.userId }),
		);
		// Charge tree-write before the bulk bucket: swapped, a tree-write refusal after a
		// successful bulk charge would burn bulk tokens on every retry.
		expect(limitSpy.mock.calls.map((call) => call[1])).toEqual(["files_tree_write", "files_bulk_import"]);
	});

	test("a refused bulk bucket check burns no tree-write token", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		vi.spyOn(RateLimiter.prototype, "check").mockResolvedValue({ ok: false, retryAfter: 1234 } as never);
		const limitSpy = vi.spyOn(RateLimiter.prototype, "limit");

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "a.pdf", contentType: "application/pdf", size: 1 }],
		});

		expect(imported._nay).toMatchObject({ message: "Rate limit exceeded", data: { retryAfterMs: 1234 } });
		expect(limitSpy).not.toHaveBeenCalled();
	});

	test("a Markdown upload finalizes through the standard R2 event and starts processing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "notes/plan.md", contentType: "text/markdown;charset=utf-8", size: 64 }],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}

		const assetId = imported._yay.created[0]!.assetId;
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", assetId));
		expect(asset?.processingWorkId).toBeUndefined();
		const assetR2Key = `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${assetId}`;
		const uploadStagingR2Key =
			asset?.uploadStagingR2Key ??
			`organizations/${db.organizationId}/workspaces/${db.workspaceId}/upload-staging/${assetId}`;
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(
			async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
		);
		// The staged object exists only in this stub: report it copied so the event can finalize.
		// Enforce the expected-identity contract like the real action, so a garbled expectedSource
		// from the event route fails here instead of staying green.
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, copyArgs) => {
			if (copyArgs.sourceKey !== uploadStagingR2Key) {
				return { outcome: "source_missing" as const };
			}
			if (copyArgs.expectedSize !== 64 || copyArgs.expectedEtag !== "etag_browser_import_1") {
				return { outcome: "source_changed" as const };
			}
			return { outcome: "copied" as const, size: 64, etag: "etag_browser_import_1" };
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url === "https://r2.test/upload" && init?.method === "PUT") {
					return new Response(null, { status: 200 });
				}
				return new Response(null, { status: 404 });
			}),
		);

		enqueueActionSpy.mockClear();
		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "browser_import_event_1",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: asset!.r2Bucket,
					object: {
						key: uploadStagingR2Key,
						size: 64,
						eTag: "etag_browser_import_1",
					},
					eventTime: "2026-08-01T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const finalized = await t.run(async (ctx) => ctx.db.get("files_r2_assets", assetId));
		expect(finalized?.r2Key).toBe(assetR2Key);
		// Unlike `data_import`, the finalizer must treat this like a single-file upload and enqueue
		// the Markdown conversion work.
		expect(enqueueActionSpy).toHaveBeenCalled();
	});
});

describe("files_nodes.get_upload_conflicts", () => {
	test("reports nodes on the target paths with their kind", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const uploaded = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "dup.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (uploaded._nay) {
			throw new Error(uploaded._nay.message);
		}
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "docs",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		const conflicts = await asUser.query(api.files_nodes.get_upload_conflicts, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			relativePaths: ["dup.pdf", "docs", "missing.pdf"],
		});
		expect(conflicts).toEqual([
			{ relativePath: "dup.pdf", kind: "file" },
			{ relativePath: "docs", kind: "folder" },
		]);
	});

	test("throws on more paths than one import call accepts", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		await expect(
			asUser.query(api.files_nodes.get_upload_conflicts, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				relativePaths: Array.from({ length: 51 }, (_, index) => `f${index}.pdf`),
			}),
		).rejects.toThrow("Too many paths");
	});
});

describe("files_nodes.discard_failed_upload_node", () => {
	test("removes an unfinalized upload after a copy crash and ledgers both possible objects", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "temp.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}
		const nodeId = imported._yay.created[0]!.nodeId;
		const assetId = imported._yay.created[0]!.assetId;
		const stagingKey = `organizations/${db.organizationId}/workspaces/${db.workspaceId}/upload-staging/${assetId}`;
		const liveKey = `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${assetId}`;

		// Simulate a crash after staging was copied to the immutable key but before the event
		// mutation stored `r2Key`. The database still looks like an unfinished upload.
		const discarded = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		expect(discarded._yay.removed).toBe(true);

		const docs = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", nodeId),
			asset: await ctx.db.get("files_r2_assets", assetId),
		}));
		expect(docs.node).toBeNull();
		expect(docs.asset).toBeNull();
		const cleanupJobs = await t.run(async (ctx) => await ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(cleanupJobs).toHaveLength(2);
		expect(cleanupJobs.find((job) => job.r2Key === stagingKey)).toMatchObject({
			reason: "upload_staging",
			generation: 1,
			putMayArriveUntil: expect.any(Number),
		});
		expect(cleanupJobs.find((job) => job.r2Key === liveKey)).toMatchObject({
			reason: "untracked_asset_event",
			generation: 1,
		});
		expect(cleanupJobs.find((job) => job.r2Key === liveKey)?.putMayArriveUntil).toBeUndefined();
		expect(deleteObjectSpy).not.toHaveBeenCalled();
	});

	test("keeps the node once the R2 event recorded the object", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "temp.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}
		const nodeId = imported._yay.created[0]!.nodeId;
		const assetId = imported._yay.created[0]!.assetId;
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", assetId, {
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${assetId}`,
			});
		});

		const discarded = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		expect(discarded._yay.removed).toBe(false);

		const node = await t.run(async (ctx) => await ctx.db.get("files_nodes", nodeId));
		expect(node).not.toBeNull();
		expect(deleteObjectSpy).not.toHaveBeenCalled();
	});

	test("answers Not found for a folder node", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "keep",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		const discarded = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId: folder._yay.nodeId,
		});
		expect(discarded._nay).toMatchObject({ message: "Not found" });
	});
});

test("rename_node returns conflict and keeps original path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_2._id,
		path: db.files.file_root_1.name,
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
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "rename-source.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected source file creation to succeed", {
			cause: createdFile._nay,
		});
	}

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		path: "renamed-extensionless",
	});
	if (renameResult._nay) {
		throw new Error("Expected rename_node to preserve caller-provided file name", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		expect(fileNode?.name).toBe("renamed-extensionless");
		expect(fileNode?.path).toBe("/renamed-extensionless");
	});
});

test("rename_node creates missing folders for nested file paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "rename-path-source.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected source file creation to succeed", {
			cause: createdFile._nay,
		});
	}

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		path: "notes/workspaces/plan.md",
	});
	if (renameResult._nay) {
		throw new Error("Expected rename_node to create the nested file path", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		expect(fileNode?.name).toBe("plan.md");
		expect(fileNode?.path).toBe("/notes/workspaces/plan.md");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("path", "/notes/workspaces"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(fileNode?.parentId).toBe(parentFolder?._id);
	});
});

test("rename_node preserves caller-provided nested file names", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	// A real editable Markdown file, created through the supported flow. The rename rule
	// lets an editable file take an extensionless name (it claims no class; swap cycles rely on
	// it), while a bare stored fixture would pin its extension and refuse.
	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: db.files.file_root_1._id,
		path: "yo.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected nested file creation to succeed", {
			cause: createdFile._nay,
		});
	}
	const nestedFileId = createdFile._yay.nodeId;

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: nestedFileId,
		path: "README",
	});
	if (renameResult._nay) {
		throw new Error("Expected rename_node to preserve nested README file name", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nestedFileId);
		expect(fileNode?.name).toBe("README");
		expect(fileNode?.path).toBe(`/${db.files.file_root_1.name}/README`);
	});
});

test("rename_node refuses a class-crossing extension and allows a basename rename", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "unsupported-source.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected source file creation to succeed", {
			cause: createdFile._nay,
		});
	}

	// A rename never converts content, so a Markdown file may not take a plain text
	// extension. This replaces the old trust-the-frontend behavior that preserved any extension.
	const crossingResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		path: "renamed-source.txt",
	});
	expect(crossingResult._nay?.message).toBe("A Markdown file must keep the .md extension");

	const afterRefusal = await t.run(async (ctx) => ctx.db.get("files_nodes", createdFile._yay.nodeId));
	expect(afterRefusal?.name).toBe("unsupported-source.md");

	// A basename-only rename inside the class still works.
	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		path: "renamed-source.md",
	});
	if (renameResult._nay) {
		throw new Error("Expected the same-class rename to succeed", {
			cause: renameResult._nay,
		});
	}

	const after = await t.run(async (ctx) => ctx.db.get("files_nodes", createdFile._yay.nodeId));
	expect(after?.name).toBe("renamed-source.md");
	expect(after?.path).toBe("/renamed-source.md");
});

test("rename_node creates missing folders for nested folder paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_2._id,
		path: "invalid/name",
	});

	if (renameResult._nay) {
		throw new Error("Expected rename_node to create the nested folder path", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(folderFileNode?.name).toBe("name");
		expect(folderFileNode?.path).toBe("/invalid/name");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("path", "/invalid"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(folderFileNode?.parentId).toBe(parentFolder?._id);
	});
});

test("move_nodes returns conflict and keeps original path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const conflictingSibling = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: db.files.file_root_2._id,
		path: db.files.file_root_1_child_1.name,
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

test("create_folder_node allows tenant files under /.mounts", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: files_ROOT_ID,
		path: ".mounts",
		membershipId: db.membershipId,
	});
	if (result._nay) {
		throw new Error("Expected creating tenant /.mounts to succeed", { cause: result._nay });
	}

	const node = await asUser.query(internal.files_nodes.get_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		visibilityUserId: db.userId,
		path: "/.mounts",
	});
	expect(node?._id).toBe(result._yay.nodeId);
	expect(node?.name).toBe(".mounts");
});

test("unarchive_nodes returns conflict when active file already has the same path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
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
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			kind: "file" as const,
		};
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf",
			path: "/report.pdf",
			treePath: "/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf.md",
			path: "/report.pdf.md",
			treePath: "/report.pdf.md",
		});

		return { sourceNodeId, generatedNodeId };
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [sourceNodeId],
	});

	const archivedDocs = await t.run(async (ctx) => {
		const sourceFileNode = await ctx.db.get("files_nodes", sourceNodeId);
		const generatedFileNode = await ctx.db.get("files_nodes", generatedNodeId);
		return { sourceFileNode, generatedFileNode };
	});
	expect(archivedDocs.sourceFileNode?.archiveOperationId).toEqual(expect.any(String));
	expect(archivedDocs.generatedFileNode?.archiveOperationId).toBeUndefined();

	await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [sourceNodeId],
	});

	const unarchivedDocs = await t.run(async (ctx) => {
		const sourceFileNode = await ctx.db.get("files_nodes", sourceNodeId);
		const generatedFileNode = await ctx.db.get("files_nodes", generatedNodeId);
		return { sourceFileNode, generatedFileNode };
	});
	expect(unarchivedDocs.sourceFileNode?.archiveOperationId).toBeUndefined();
	expect(unarchivedDocs.generatedFileNode?.archiveOperationId).toBeUndefined();
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
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "folder",
			kind: "folder",
			path: "/folder",
			treePath: "/folder/",
		});
		const sharedNode = {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: folderId,
			kind: "file" as const,
		};
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf",
			path: "/folder/report.pdf",
			treePath: "/folder/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf.md",
			path: "/folder/report.pdf.md",
			treePath: "/folder/report.pdf.md",
		});

		return { folderId, sourceNodeId, generatedNodeId };
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [folderId],
	});

	const archivedDocs = await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", folderId);
		const sourceFileNode = await ctx.db.get("files_nodes", sourceNodeId);
		const generatedFileNode = await ctx.db.get("files_nodes", generatedNodeId);
		return { folderFileNode, sourceFileNode, generatedFileNode };
	});
	expect(archivedDocs.folderFileNode?.archiveOperationId).toEqual(expect.any(String));
	expect(archivedDocs.sourceFileNode?.archiveOperationId).toBe(archivedDocs.folderFileNode?.archiveOperationId);
	expect(archivedDocs.generatedFileNode?.archiveOperationId).toBe(archivedDocs.folderFileNode?.archiveOperationId);

	await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [folderId],
	});

	const unarchivedDocs = await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", folderId);
		const sourceFileNode = await ctx.db.get("files_nodes", sourceNodeId);
		const generatedFileNode = await ctx.db.get("files_nodes", generatedNodeId);
		return { folderFileNode, sourceFileNode, generatedFileNode };
	});
	expect(unarchivedDocs.folderFileNode?.archiveOperationId).toBeUndefined();
	expect(unarchivedDocs.sourceFileNode?.archiveOperationId).toBeUndefined();
	expect(unarchivedDocs.generatedFileNode?.archiveOperationId).toBeUndefined();
});

test("unarchive_nodes excludes unrequested ancestors from Archive Operation", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
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
		external_id: db.userId,
		name: "Test User",
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});

	const renameArchived = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_2._id,
		path: db.files.file_root_1.name,
	});
	if (renameArchived._nay) {
		throw new Error("Expected archived rename to succeed");
	}

	const resolvedRoot1 = await asUser.query(internal.files_nodes.get_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		visibilityUserId: db.userId,
		path: `/${db.files.file_root_1.name}`,
	});

	expect(resolvedRoot1?._id).toBe(db.files.file_root_1._id);
});

test("create_file_by_path creates active ancestors instead of reusing archived nodes", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});

	const createByPath = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
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
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("path", root2Path),
			)
			.collect();
		expect(filesAtRoot2Path).toHaveLength(2);

		const activeRoot2 = filesAtRoot2Path.find((fileNode) => fileNode.archiveOperationId === undefined);
		if (!activeRoot2) {
			throw new Error("Expected active root2 file to exist");
		}

		expect(activeRoot2._id).not.toBe(db.files.file_root_2._id);

		const createdLeaf = await ctx.db.get("files_nodes", createByPath._yay.nodeId);
		expect(createdLeaf?.parentId).toBe(activeRoot2._id);
		expect(createdLeaf?.path).toBe(`/${db.files.file_root_2.name}/new-leaf.md`);
	});
});

test("N07 rename_node idempotency: same name no-op", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const before = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1._id));

	const renameResult = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		path: db.files.file_root_1.name,
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
		external_id: db.userId,
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
	// A same-parent drop is a full no-op: no updatedBy/updatedAt stamp.
	expect(after?.updatedBy).toBe(before?.updatedBy);
	expect(after?.updatedAt).toBe(before?.updatedAt);
});

test("N09 archive idempotency", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
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
		external_id: db.userId,
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
		external_id: db.userId,
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
		external_id: db.userId,
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
		path: "should-not-rename",
	});
	if (!unauthorizedRename._nay) {
		throw new Error("Expected rename_node to reject cross-user membership access");
	}
	expect(unauthorizedRename._nay.message).toBe("Unauthorized");

	const createdFile = await asOwner.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "membership-yjs-regression.md",
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
			organizationName: "rl-other-ws",
			workspaceName: "rl-other-prj",
		});
	});
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Tree Rate User",
	});
	const createdNodeIds: Array<Id<"files_nodes">> = [];

	for (let i = 0; i < 2; i++) {
		const result = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: `tree-rate-limit-${i}.md`,
		});
		if (result._nay) {
			throw new Error(`Expected tree write #${i + 1} to succeed, got: ${result._nay.message}`);
		}

		createdNodeIds.push(result._yay.nodeId);
	}

	// `files_tree_write` is a BULK_FILES_WRITE bucket (capacity 50), so drain it with cheap
	// wrong-membership renames: each consumes a token before membership validation fails,
	// until the limiter answers first — which is the ordering this test pins.
	let blockedMessage: string | undefined;
	for (let i = 0; i < 60 && blockedMessage == null; i++) {
		const result = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: otherDb.membershipId,
			nodeId: createdNodeIds[0],
			path: "should-rate-limit-before-membership.md",
		});
		if (result._nay?.message === "Rate limit exceeded") {
			blockedMessage = result._nay.message;
		} else {
			expect(result._nay?.message).toBe("Unauthorized");
		}
	}

	expect(blockedMessage).toBe("Rate limit exceeded");
});

test("files_snapshot_write rate limit runs before restore snapshot validation", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const restoreAssets = await t.run(async (ctx) => {
		const [snapshotAssetId, currentSnapshotAssetId, restoredSnapshotAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/snapshot-rate-limit`,
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: db.files.file_root_1._id,
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

	const blocked = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
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

test("materialize_file_content writes empty version and Yjs snapshots to R2 and no current-content object", async () => {
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

	const createdFile = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/empty-materialized.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId: createdFile._yay.nodeId,
		userId: db.userId,
		targetSequence: 0,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!fileNode?.assetId || !fileNode.yjsSnapshotId) {
			throw new Error("Expected materialized empty file docs");
		}
		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId),
			)
			.collect();
		const versionSnapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId)
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
	// Editable files do not store their current content in R2: materialization uploads the Yjs
	// and version snapshots and points the node at the fresh version snapshot.
	expect(saved.asset).toMatchObject({
		kind: "content_snapshot",
		size: 0,
	});
	expect(saved.asset?.r2Key).toBe(
		`organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.asset?._id}`,
	);
	expect(saved.versionSnapshots.some((snapshot) => snapshot.assetId === saved.asset?._id)).toBe(true);
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.yjsSnapshotAsset?._id}`,
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.versionSnapshots.length).toBeGreaterThan(0);
	expect(versionSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${versionSnapshotAsset?._id}`,
		size: 0,
	});
	const versionSnapshotR2Key = versionSnapshotAsset?.r2Key;
	const yjsSnapshotR2Key = saved.yjsSnapshotAsset?.r2Key;
	if (!versionSnapshotR2Key || !yjsSnapshotR2Key) {
		throw new Error("Expected version and Yjs snapshot R2 keys");
	}
	expect(r2Writes.get(saved.asset?.r2Key ?? "")).toBe("");
	expect(r2Writes.get(versionSnapshotR2Key)).toBe("");
	expect(r2Writes.has(yjsSnapshotR2Key)).toBe(true);
});

test("materialize_file_content writes nonempty version and Yjs snapshots to R2 and no current-content object", async () => {
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

	const createdFile = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/materialized.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const markdown = "# Café\n\nEmoji 🙂\n";
	const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: markdown });
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

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId: createdFile._yay.nodeId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	// Finalization schedules the covered-doc cleanup instead of deleting in-transaction;
	// convex-test never runs scheduled functions, so drain it directly before the readback.
	await t.mutation(internal.files_nodes_content.cleanup_file_materialization_covered_rows, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId: createdFile._yay.nodeId,
		throughSequence: 1,
	});

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!fileNode?.assetId || !fileNode.yjsSnapshotId) {
			throw new Error("Expected materialized file docs");
		}
		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId),
			)
			.collect();
		const versionSnapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId)
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
	// Editable files do not store their current content in R2: materialization uploads the Yjs
	// and version snapshots and points the node at the fresh version snapshot.
	expect(saved.asset).toMatchObject({
		kind: "content_snapshot",
		size: files_get_utf8_byte_size(markdown),
	});
	expect(saved.asset?._id).toBe(versionSnapshotAsset?._id);
	expect(saved.yjsSnapshot?.sequence).toBe(1);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.yjsSnapshotAsset?._id}`,
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.versionSnapshots.length).toBeGreaterThan(0);
	expect(versionSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${versionSnapshotAsset?._id}`,
		size: files_get_utf8_byte_size(markdown),
	});
	const versionSnapshotR2Key = versionSnapshotAsset?.r2Key;
	const yjsSnapshotR2Key = saved.yjsSnapshotAsset?.r2Key;
	if (!versionSnapshotR2Key || !yjsSnapshotR2Key) {
		throw new Error("Expected version and Yjs snapshot R2 keys");
	}
	expect(r2Writes.get(versionSnapshotR2Key)).toBe(markdown);
	expect(r2Writes.has(yjsSnapshotR2Key)).toBe(true);
});

// Wire R2 so materialization round-trips through an in-memory bucket keyed by the per-file upload key:
// generateUploadUrl/getURL/fetch all read and write the returned `r2Writes` map. Returned so a test
// can recover the exact committed markdown a file's content asset points at (the chunk-read oracle).
function test_setup_r2_capture() {
	const r2Writes = new Map<string, BodyInit>();
	generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
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
	return r2Writes;
}

// Create a file at `path`, push its markdown as the first Yjs update, and materialize it (sequence 1)
// so its content lands in R2 + the markdown/plain-text chunk tables. Returns the node id.
async function test_materialize_markdown_file(
	t: ReturnType<typeof test_convex>,
	asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>,
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>,
	path: string,
	markdown: string,
) {
	const created = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
	});
	if (created._nay) throw new Error(created._nay.message);
	const nodeId = created._yay.nodeId;
	const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: markdown });
	if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
		sessionId: `mat-${path}`,
	});
	yjsDoc.destroy();
	if (pushResult._nay) throw new Error(pushResult._nay.message);
	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (materialized._nay) throw new Error(materialized._nay.message);
	return nodeId;
}

test("materialize_file_content rolls back Convex writes when committed chunking fails", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Chunk Failure User",
		email: "chunk-failure-user@example.com",
	});
	test_setup_r2_capture();

	const nodeId = await test_materialize_markdown_file(t, asUser, db, "/chunk-failure.md", "# Last good\n");
	const nextYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "# Next version\n" });
	if ("_nay" in nextYjsDoc) {
		throw new Error(nextYjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(nextYjsDoc)),
		sessionId: "chunk-failure-session",
	});
	nextYjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const before = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		const yjsSnapshot = fileNode?.yjsSnapshotId
			? await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId)
			: null;
		const textChunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect();
		return { fileNode, yjsSnapshot, textChunks };
	});

	const chunkMarkdownSpy = vi
		.spyOn(await import("../server/files-markdown-chunking-mastra.ts"), "files_chunk_markdown")
		.mockResolvedValueOnce(
			Result({
				_nay: {
					name: "nay",
					message: "Error while chunking markdown",
					cause: new Error("Test chunking failure"),
				},
			}),
		);

	await expect(
		t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: pushResult._yay.newSequence,
		}),
	).rejects.toThrow("Failed to materialize file content");
	expect(chunkMarkdownSpy).toHaveBeenCalled();

	const after = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		const yjsSnapshot = fileNode?.yjsSnapshotId
			? await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId)
			: null;
		const textChunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect();
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect();
		const jobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.collect();
		return { fileNode, yjsSnapshot, textChunks, yjsUpdates, jobs };
	});

	expect(after.fileNode?.assetId).toBe(before.fileNode?.assetId);
	expect(after.yjsSnapshot?.sequence).toBe(before.yjsSnapshot?.sequence);
	expect(after.textChunks).toEqual(before.textChunks);
	expect(after.yjsUpdates).not.toHaveLength(0);
	expect(after.jobs).not.toHaveLength(0);
});

test("materialize_file_content marks over-cap content too large and leaves the node on its last good content", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Too Large User",
		email: "too-large-user@example.com",
	});
	const r2Writes = test_setup_r2_capture();

	const smallMarkdown = "# Small\n";
	const nodeId = await test_materialize_markdown_file(t, asUser, db, "/too-large.md", smallMarkdown);
	const beforePush = await t.run(async (ctx) => ({
		assetCount: (await ctx.db.query("files_r2_assets").collect()).length,
		assetId: (await ctx.db.get("files_nodes", nodeId))?.assetId,
	}));
	const r2WriteCountBeforePush = r2Writes.size;

	// Two very long paragraphs rather than many short ones: the byte size is what matters, and
	// Yjs stores each paragraph as one item. The document must cross the 900000-byte text cap
	// while its one encoded update stays under door 1's 930000-byte wire cap, so target just
	// past the text cap. Plain `x` runs also round-trip through Markdown unchanged.
	const overCapParagraph = `${"x".repeat(files_MAX_TEXT_CONTENT_BYTES / 2 + 2)}\n\n`;
	const overCapMarkdown = overCapParagraph.repeat(2);
	const overCapYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: overCapMarkdown });
	if ("_nay" in overCapYjsDoc) {
		throw new Error(overCapYjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(overCapYjsDoc)),
		sessionId: "too-large-session",
	});
	overCapYjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: pushResult._yay.newSequence,
	});

	expect(materialized._nay).toMatchObject({
		message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`,
	});

	const afterReject = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		const jobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.collect();
		const assetCount = (await ctx.db.query("files_r2_assets").collect()).length;
		return { fileNode, jobs, assetCount };
	});

	expect(afterReject.fileNode?.contentTooLargeByteSize).toBeGreaterThan(files_MAX_TEXT_CONTENT_BYTES);
	// The node keeps pointing at the last content that fit, so every committed reader stays readable.
	expect(afterReject.fileNode?.assetId).toBe(beforePush.assetId);
	// Retrying cannot make the content smaller, so the job settles instead of lingering.
	expect(afterReject.jobs).toHaveLength(0);
	// The guard runs before `insert_asset` and the R2 writes, so an over-cap run leaves no orphan
	// asset doc and no new object in the bucket.
	expect(afterReject.assetCount).toBe(beforePush.assetCount);
	expect(r2Writes.size).toBe(r2WriteCountBeforePush);
});

test("materialize_file_content settles over-cap frontmatter with the marker pair before any asset write", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Frontmatter Cap User",
	});
	const r2Writes = test_setup_r2_capture();

	// Seed without a push (the rate limiter allows two pushes per test window and this test
	// needs both for the over-cap and the fitting content).
	const createdFile = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/frontmatter-cap.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const nodeId = createdFile._yay.nodeId;
	const seededMaterialize = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: 0,
	});
	if (seededMaterialize._nay) {
		throw new Error(seededMaterialize._nay.message);
	}
	const beforePush = await t.run(async (ctx) => ({
		assetCount: (await ctx.db.query("files_r2_assets").collect()).length,
		assetId: (await ctx.db.get("files_nodes", nodeId))?.assetId,
	}));
	const r2WriteCountBeforePush = r2Writes.size;

	// 129 frontmatter fields: over the field cap, far under the byte cap. The editor path goes
	// through yjs_push_update, so the pending-path preflight never runs for it.
	const overCapMarkdown = `---\n${Array.from({ length: files_metadata_MAX_FRONTMATTER_FIELDS + 1 }, (_, index) => `field_${index}: ${index}`).join("\n")}\n---\n\n# Body\n`;
	const overCapYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: overCapMarkdown });
	if ("_nay" in overCapYjsDoc) {
		throw new Error(overCapYjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(overCapYjsDoc)),
		sessionId: "frontmatter-cap-session",
	});
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: pushResult._yay.newSequence,
	});
	expect(materialized._nay).toMatchObject({ message: "Frontmatter exceeds the index caps" });

	const afterReject = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		const jobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.collect();
		const assetCount = (await ctx.db.query("files_r2_assets").collect()).length;
		return { fileNode, jobs, assetCount };
	});

	// Both marker halves are written and the job settles: retrying cannot shrink the frontmatter.
	expect(afterReject.fileNode?.contentFrontmatterTooLargeFieldCount).toBe(files_metadata_MAX_FRONTMATTER_FIELDS + 1);
	expect(afterReject.fileNode?.contentFrontmatterTooLargeIndexDocumentCount).toBeGreaterThan(
		files_metadata_MAX_FRONTMATTER_FIELDS + 1,
	);
	expect(afterReject.jobs).toHaveLength(0);
	// The preflight runs before `insert_asset` and the R2 uploads, so the refusal leaves no
	// orphan asset doc and no new object, and the node keeps its last good content.
	expect(afterReject.fileNode?.assetId).toBe(beforePush.assetId);
	expect(afterReject.assetCount).toBe(beforePush.assetCount);
	expect(r2Writes.size).toBe(r2WriteCountBeforePush);

	// The next fitting content clears both marker halves at finalization. Build it as a diff on
	// the live document's own lineage: pushing a fresh doc's whole state would MERGE with the
	// over-cap frontmatter instead of replacing it.
	const fittingDoc = files_yjs_doc_clone({ yjsDoc: overCapYjsDoc });
	const fitted = files_yjs_doc_update_from_text({
		mut_yjsDoc: fittingDoc,
		text: "# Small again\n",
		rootKind: "rich_text",
	});
	if (fitted._nay) {
		throw new Error(fitted._nay.message);
	}
	const fittingDiff = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: fittingDoc, yjsBeforeDoc: overCapYjsDoc });
	if (!fittingDiff) {
		throw new Error("Expected the fitting content to produce a diff update");
	}
	const fittingPush = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		update: files_u8_to_array_buffer(fittingDiff),
		sessionId: "frontmatter-cap-session",
	});
	overCapYjsDoc.destroy();
	fittingDoc.destroy();
	if (fittingPush._nay) {
		throw new Error(fittingPush._nay.message);
	}
	const rematerialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: fittingPush._yay.newSequence,
	});
	expect(rematerialized._nay).toBeUndefined();
	const cleared = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
	expect(cleared?.contentFrontmatterTooLargeFieldCount).toBeUndefined();
	expect(cleared?.contentFrontmatterTooLargeIndexDocumentCount).toBeUndefined();
});

test("materialize_file_content clears the too-large mark once the content fits again", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Trimmed User",
		email: "trimmed-user@example.com",
	});
	test_setup_r2_capture();

	const nodeId = await test_materialize_markdown_file(t, asUser, db, "/trimmed.md", "# Trimmed\n");
	await t.run(async (ctx) => {
		return await ctx.db.patch("files_nodes", nodeId, {
			contentTooLargeByteSize: files_MAX_TEXT_CONTENT_BYTES + 1,
		});
	});

	const trimmedYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "# Trimmed again\n" });
	if ("_nay" in trimmedYjsDoc) {
		throw new Error(trimmedYjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(trimmedYjsDoc)),
		sessionId: "trimmed-session",
	});
	trimmedYjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: pushResult._yay.newSequence,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	const fileNode = await t.run(async (ctx) => await ctx.db.get("files_nodes", nodeId));
	expect(fileNode?.contentTooLargeByteSize).toBeUndefined();
});

async function test_insert_searchable_markdown_file(
	t: ReturnType<typeof test_convex>,
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>,
	path: string,
	markdown: string,
) {
	// Seed only the node and committed plain-text chunk docs for tests that exercise search scope.
	return await t.run(async (ctx) => {
		const now = Date.now();
		const name = path.split("/").filter(Boolean).at(-1);
		if (!name) throw new Error("Expected a root-level file path");
		const nodeId = await ctx.db.insert("files_nodes", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path,
			treePath: path,
			pathDepth: 1,
			lowercaseExtension: "md",
			name,
			kind: "file",
			contentType: "text/markdown;charset=utf-8",
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: now,
		});
		const chunks = await db_insert_file_text_content(ctx, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			path,
			yjsSequence: 0,
			rootKind: "rich_text",
			textContent: markdown,
		});
		if (chunks._nay) throw new Error(chunks._nay.message);
		return nodeId;
	});
}

// Get the exact committed markdown for a file, to compare chunk reads against. Editable files
// do not store their current content in R2, so read the newest version snapshot instead:
// materialization writes the exact committed markdown there.
async function test_read_committed_markdown(
	t: ReturnType<typeof test_convex>,
	nodeId: Id<"files_nodes">,
	r2Writes: Map<string, BodyInit>,
) {
	return t.run(async (ctx) => {
		const snapshots = (await ctx.db.query("files_snapshots").collect()).filter(
			(snapshot) => snapshot.fileNodeId === nodeId && snapshot.archivedAt <= 0,
		);
		const newest = snapshots.sort((a, b) => b._creationTime - a._creationTime)[0];
		const asset = newest ? await ctx.db.get("files_r2_assets", newest.assetId) : null;
		return asset?.r2Key ? (r2Writes.get(asset.r2Key) as string | undefined) : undefined;
	});
}

test("read_committed_file_chunks_line_range/stats match full-text slicing across chunks", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Chunk Read User",
		email: "chunk-read-user@example.com",
	});
	const r2Writes = test_setup_r2_capture();

	// Long enough to materialize into several chunks (default maxChunkSize 1200), so reads exercise
	// the cross-chunk seek + merge, not a single chunk.
	const paragraphs = Array.from(
		{ length: 40 },
		(_, i) =>
			`Paragraph ${i + 1} carries searchable words alpha-${i} beta gamma delta epsilon zeta eta theta${i === 0 ? " 🙂" : ""}.`,
	);
	const markdown = `# Chunked Document\n\n${paragraphs.join("\n\n")}`;

	const createdFile = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/chunked.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const nodeId = createdFile._yay.nodeId;

	const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: markdown });
	if ("_nay" in yjsDoc) {
		throw new Error(yjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
		sessionId: "chunk-read-session",
	});
	yjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	// Compare against the exact committed markdown the chunker saw: materialization writes it to
	// the version snapshot. The chunk reader must return the same line ranges as slicing that text.
	const committed = await test_read_committed_markdown(t, nodeId, r2Writes);
	const chunkCount = await t.run(async (ctx) => {
		const chunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect();
		return chunks.length;
	});
	if (committed === undefined) {
		throw new Error("Expected committed markdown to be stored in R2");
	}
	// Guard the test is meaningful: the document really spans multiple chunks.
	expect(chunkCount).toBeGreaterThan(1);

	const totalLines = committed.split("\n").length;
	const readRange = (startLine: number, maxLines: number, fromEnd = false) =>
		asUser.query(internal.files_nodes.read_committed_file_chunks_line_range, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/chunked.md",
			startLine,
			maxLines,
			fromEnd,
		});

	// Head, a deep mid-document range (the case the leading byte window could not reach), and the
	// final lines — each must equal slicing the full committed text.
	for (const [startLine, maxLines] of [
		[1, 5],
		[41, 6],
		[Math.max(1, totalLines - 3), 10],
	] as const) {
		const result = await readRange(startLine, maxLines);
		expect(result.usable).toBe(true);
		if (!result.usable) throw new Error("expected usable");
		expect(result.content).toBe(files_line_range_from_text(committed, startLine, maxLines).content);
	}

	// moreLines after the bounded-streaming refactor: a shallow read reports content follows; a range
	// entirely past EOF does not (and is a valid empty page, not a fallback).
	const shallow = await readRange(1, 5);
	expect(shallow.usable && shallow.moreLines).toBe(true);
	const pastEof = await readRange(totalLines + 50, 5);
	expect(pastEof.usable).toBe(true);
	if (!pastEof.usable) throw new Error("expected usable");
	expect(pastEof.content).toBe("");
	expect(pastEof.moreLines).toBe(false);

	// tail.
	const tail = await readRange(1, 5, true);
	expect(tail.usable).toBe(true);
	if (!tail.usable) throw new Error("expected usable");
	expect(tail.content).toBe(files_tail_lines_from_text(committed, 5).content);

	// Exact counts from chunks match counting the full committed text.
	const stats = await asUser.query(internal.files_nodes.read_committed_file_chunk_stats, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/chunked.md",
	});
	expect(stats.usable).toBe(true);
	if (!stats.usable) throw new Error("expected usable");
	expect(stats.lineCount).toBe((committed.match(/\n/gu) ?? []).length);
	// charCount is Unicode code points (wc -m), not UTF-16 units: the 🙂 makes these differ.
	expect(Array.from(committed).length).toBeLessThan(committed.length);
	expect(stats.charCount).toBe(Array.from(committed).length);
	expect(stats.byteCount).toBe(files_get_utf8_byte_size(committed));
	expect(stats.wordCount).toBe(committed.trim().length === 0 ? 0 : committed.trim().split(/\s+/u).length);

	// Currency gate: a stale snapshot (latest sequence ahead of the materialized snapshot) must not
	// use chunks — the action falls back so output can never disagree with `cat`.
	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		const snapshot = fileNode?.yjsSnapshotId ? await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId) : null;
		if (!fileNode?.yjsLastSequenceId || !snapshot) {
			throw new Error("Expected materialized yjs docs");
		}
		await ctx.db.patch("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId, {
			lastSequence: snapshot.sequence + 1,
		});
	});
	const staleResult = await readRange(1, 5);
	expect(staleResult.usable).toBe(false);
});

test("match_text_file_lines and match_plain_text_file_lines query committed and pending chunks", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Query Grep User",
		email: "query-grep-user@example.com",
	});
	const r2Writes = test_setup_r2_capture();

	const path = "/grep-query.md";
	const committedMarkdown = "intro context\n**critical** alert\ncommittedneedle one\nmiddle\ncommittedneedle two\n";
	const nodeId = await test_materialize_markdown_file(t, asUser, db, path, committedMarkdown);
	const committed = await test_read_committed_markdown(t, nodeId, r2Writes);
	if (committed === undefined) throw new Error("Expected committed markdown");

	const grepArgs = {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		fileNodeId: nodeId,
	};

	const committedGrep = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "committedneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(committedGrep).not.toBeNull();
	if (!committedGrep) throw new Error("expected committed grep");
	expect(committedGrep.lines.map(({ lineNumber, line }) => ({ lineNumber, line }))).toEqual([
		{ lineNumber: 3, line: "committedneedle one" },
		{ lineNumber: 5, line: "committedneedle two" },
	]);
	expect(committedGrep.scanTruncated).toBe(false);

	const committedRegexGrep = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: String.raw`committedneedle\s+(one|two)`,
		ignoreCase: false,
		fixedStrings: false,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(committedRegexGrep).not.toBeNull();
	if (!committedRegexGrep) throw new Error("expected committed regex grep");
	expect(committedRegexGrep.lines.map(({ lineNumber, line }) => ({ lineNumber, line }))).toEqual([
		{ lineNumber: 3, line: "committedneedle one" },
		{ lineNumber: 5, line: "committedneedle two" },
	]);
	expect(committedRegexGrep.scanTruncated).toBe(false);

	const committedPlainRegex = await asUser.query(internal.files_nodes.match_plain_text_file_lines, {
		...grepArgs,
		pattern: String.raw`critical\s+alert`,
		ignoreCase: false,
		fixedStrings: false,
		invert: false,
	});
	expect(committedPlainRegex).not.toBeNull();
	if (!committedPlainRegex) throw new Error("expected committed plain-text regex grep");
	expect(committedPlainRegex.lines).toEqual([{ lineNumber: 2, line: "critical alert", matched: true }]);
	expect(committedPlainRegex.scanTruncated).toBe(false);

	const committedPlainLiteral = await asUser.query(internal.files_nodes.match_plain_text_file_lines, {
		...grepArgs,
		pattern: "critical alert",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
	});
	expect(committedPlainLiteral).not.toBeNull();
	if (!committedPlainLiteral) throw new Error("expected committed plain-text literal grep");
	expect(committedPlainLiteral.lines).toEqual([{ lineNumber: 2, line: "critical alert", matched: true }]);
	expect(committedPlainLiteral.selectedCount).toBe(1);

	const committedPlainLiteralMeta = await asUser.query(internal.files_nodes.match_plain_text_file_lines, {
		...grepArgs,
		pattern: "critical.alert",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
	});
	expect(committedPlainLiteralMeta).not.toBeNull();
	if (!committedPlainLiteralMeta) throw new Error("expected committed plain-text literal-meta grep");
	// `-F` treats `.` literally, so "critical.alert" does not match "critical alert".
	expect(committedPlainLiteralMeta.lines).toEqual([]);
	expect(committedPlainLiteralMeta.selectedCount).toBe(0);

	const committedPlainInvert = await asUser.query(internal.files_nodes.match_plain_text_file_lines, {
		...grepArgs,
		pattern: String.raw`critical\s+alert`,
		ignoreCase: false,
		fixedStrings: false,
		invert: true,
	});
	expect(committedPlainInvert).not.toBeNull();
	if (!committedPlainInvert) throw new Error("expected committed plain-text inverted grep");
	// `-v` keeps every non-matching line, so the one matching line is excluded.
	expect(committedPlainInvert.lines.some((line) => line.line === "critical alert")).toBe(false);
	expect(committedPlainInvert.lines.length).toBeGreaterThan(0);
	expect(committedPlainInvert.selectedCount).toBe(committedPlainInvert.lines.length);

	const committedScan = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "committedneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 1,
		after: 1,
	});
	expect(committedScan).not.toBeNull();
	if (!committedScan) throw new Error("expected committed grep scan");
	expect(committedScan.lines).toEqual([
		{ lineNumber: 2, line: "**critical** alert", matched: false },
		{ lineNumber: 3, line: "committedneedle one", matched: true },
		{ lineNumber: 4, line: "middle", matched: false },
		{ lineNumber: 5, line: "committedneedle two", matched: true },
	]);
	expect(committedScan.selectedCount).toBe(2);
	expect(committedScan.scanTruncated).toBe(false);

	const committedWindow = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "committedneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
		window: { kind: "lines", startLine: 5, maxLines: 2 },
	});
	expect(committedWindow).not.toBeNull();
	if (!committedWindow) throw new Error("expected committed window grep");
	expect(committedWindow.lines).toEqual([{ lineNumber: 5, line: "committedneedle two", matched: true }]);
	expect(committedWindow.scanTruncated).toBe(false);

	const cappedOutputMarkdown = [
		"outputneedle-primer",
		...Array.from({ length: 24 }, (_, lineIndex) => `group-1-before-${lineIndex + 1}`),
		"outputneedle-01",
		...Array.from({ length: 25 }, (_, lineIndex) => `group-1-after-${lineIndex + 1}`),
		...Array.from({ length: 154 }, (_, index) =>
			index % 2 === 0 ? `outputneedle-dense-${index + 1}` : `dense-filler-${index + 1}`,
		),
	].join("\n");
	const cappedOutputNodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		"/grep-capped-output.md",
		cappedOutputMarkdown,
	);
	const cappedContextScan = await asUser.query(internal.files_nodes.match_text_file_lines, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		fileNodeId: cappedOutputNodeId,
		pattern: "outputneedle-01",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 100,
		after: 100,
	});
	expect(cappedContextScan).not.toBeNull();
	if (!cappedContextScan) throw new Error("expected capped context scan");
	expect(cappedContextScan.lines.map((line) => line.lineNumber)).toEqual(
		Array.from({ length: 41 }, (_, index) => index + 6),
	);
	expect(cappedContextScan.scanTruncated).toBe(true);

	const cappedOutputScan = await asUser.query(internal.files_nodes.match_text_file_lines, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		fileNodeId: cappedOutputNodeId,
		pattern: "outputneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 20,
		after: 20,
	});
	expect(cappedOutputScan).not.toBeNull();
	if (!cappedOutputScan) throw new Error("expected capped output scan");
	expect(cappedOutputScan.lines.length).toBe(200);
	expect(cappedOutputScan.scanTruncated).toBe(true);

	const pendingMarkdown = "pending context\n**pending** alert\npendingneedle only in the pending version\n";
	const pending = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId,
		unstagedMarkdown: pendingMarkdown,
	});
	if (pending._nay) throw new Error(pending._nay.message);

	const pendingGrep = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "pendingneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(pendingGrep).not.toBeNull();
	if (!pendingGrep) throw new Error("expected pending grep");
	expect(pendingGrep.lines.map(({ lineNumber, line }) => ({ lineNumber, line }))).toEqual([
		{ lineNumber: 3, line: "pendingneedle only in the pending version" },
	]);

	const pendingWindow = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "pendingneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
		window: { kind: "lines", startLine: 3, maxLines: 2 },
	});
	expect(pendingWindow).not.toBeNull();
	if (!pendingWindow) throw new Error("expected pending window grep");
	expect(pendingWindow.lines).toEqual([
		{ lineNumber: 3, line: "pendingneedle only in the pending version", matched: true },
	]);
	expect(pendingWindow.scanTruncated).toBe(false);

	const pendingPlainRegex = await asUser.query(internal.files_nodes.match_plain_text_file_lines, {
		...grepArgs,
		pattern: String.raw`pending\s+alert`,
		ignoreCase: false,
		fixedStrings: false,
		invert: false,
	});
	expect(pendingPlainRegex).not.toBeNull();
	if (!pendingPlainRegex) throw new Error("expected pending plain-text regex grep");
	expect(pendingPlainRegex.lines).toEqual([{ lineNumber: 2, line: "pending alert", matched: true }]);

	const staleCommittedGrep = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "committedneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(staleCommittedGrep).not.toBeNull();
	if (!staleCommittedGrep) throw new Error("expected pending grep view");
	expect(staleCommittedGrep.lines).toEqual([]);

	await t.run(async (ctx) => {
		const chunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", cappedOutputNodeId),
			)
			.collect();
		const secondChunk = chunks[1];
		if (!secondChunk) {
			throw new Error("Expected more than one chunk");
		}
		await ctx.db.patch("files_text_chunks", secondChunk._id, { startIndex: secondChunk.startIndex + 1 });
	});

	const brokenGrep = await asUser.query(internal.files_nodes.match_text_file_lines, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		fileNodeId: cappedOutputNodeId,
		pattern: "outputneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(brokenGrep).toBeNull();
});

// Seed an external (reserved-scope) committed file the way a read-only mount will: a node with no
// Yjs/pending/materialization, committed markdown + plain-text chunks with NO yjsSequence, a linked
// R2 `content` asset, and exact wc stats. `r2Writes` gets the raw body so action-level R2 reads
// resolve. Returns the node id. Mirrors committed chunk doc shapes minus yjsSequence.
async function test_insert_committed_external_markdown(
	t: ReturnType<typeof test_convex>,
	r2Writes: Map<string, BodyInit>,
	userId: Id<"users">,
	path: string,
	markdown: string,
) {
	const chunks = await files_chunk_markdown(markdown);
	if (chunks._nay) throw new Error(chunks._nay.message);
	const byteSize = files_get_utf8_byte_size(markdown);
	return await t.run(async (ctx) => {
		const now = Date.now();
		const name = path.split("/").filter(Boolean).at(-1);
		if (!name) throw new Error("Expected a root-level file path");
		const nodeId = await ctx.db.insert("files_nodes", {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			parentId: files_ROOT_ID,
			path,
			treePath: path,
			pathDepth: 1,
			lowercaseExtension: "md",
			name,
			kind: "file",
			contentType: "text/markdown;charset=utf-8",
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
			updatedAt: now,
		});
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			kind: "content",
			r2Bucket: "test-bucket",
			r2Key: `mounts${path}`,
			size: byteSize,
			createdBy: users_SYSTEM_AUTHOR,
			updatedAt: now,
		});
		r2Writes.set(`mounts${path}`, markdown);
		const statsId = await ctx.db.insert("file_stats", {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			fileNodeId: nodeId,
			lineCount: (markdown.match(/\n/gu) ?? []).length,
			wordCount: markdown.trim().length === 0 ? 0 : markdown.trim().split(/\s+/u).length,
			charCount: Array.from(markdown).length,
		});
		await ctx.db.patch("files_nodes", nodeId, { assetId, statsId });
		// Committed chunks with yjsSequence OMITTED: external rows are addressed by node id alone.
		const textChunkIds = await Promise.all(
			chunks._yay.map((chunk) =>
				ctx.db.insert("files_text_chunks", {
					organizationId: organizations_GLOBAL_ORGANIZATION_ID,
					workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
					fileNodeId: nodeId,
					sourceKind: "committed",
					chunkIndex: chunk.chunkIndex,
					textChunk: chunk.textChunk,
					startIndex: chunk.startIndex,
					endIndex: chunk.endIndex,
					lineStart: chunk.lineStart,
					lineEnd: chunk.lineEnd,
					chunkFlags: chunk.chunkFlags,
				}),
			),
		);
		await Promise.all(
			chunks._yay.map((chunk, index) =>
				ctx.db.insert("files_plain_text_chunks", {
					organizationId: organizations_GLOBAL_ORGANIZATION_ID,
					workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
					fileNodeId: nodeId,
					sourceKind: "committed",
					textChunkId: textChunkIds[index],
					chunkIndex: chunk.chunkIndex,
					path,
					plainTextChunk: chunk.plainTextChunk,
					textChunk: chunk.textChunk,
					startIndex: chunk.startIndex,
					endIndex: chunk.endIndex,
					lineStart: chunk.lineStart,
					lineEnd: chunk.lineEnd,
					chunkFlags: chunk.chunkFlags,
					hasChunkAbove: index > 0,
					hasChunkBelow: index < chunks._yay.length - 1,
				}),
			),
		);
		return nodeId;
	});
}

test("external (reserved) scope reads committed chunks and R2 without Yjs, pending, or materialization", async () => {
	const t = test_convex();
	// A real acting user id (the tenant user reading an external mount); the file itself is reserved-scope.
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const r2Writes = test_setup_r2_capture();

	const paragraphs = Array.from(
		{ length: 50 },
		(_, i) =>
			`External paragraph ${i + 1} carries words alpha-${i} beta gamma delta epsilon zeta eta theta${i === 0 ? " 🙂" : ""}.`,
	);
	const path = "/.mounts/github/external-doc.md";
	const markdown = [
		"# External Mount Document",
		"",
		"externalneedle one",
		"**critical** mount alert",
		"externalsearchneedle appears once here.",
		"",
		...paragraphs,
		"",
		"externalneedle two",
		"",
	].join("\n");

	const nodeId = await test_insert_committed_external_markdown(t, r2Writes, db.userId, path, markdown);

	// Guard the test is meaningful: the document really spans multiple committed chunks.
	const chunkCount = await t.run(async (ctx) =>
		ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
					.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect()
			.then((chunks) => chunks.length),
	);
	expect(chunkCount).toBeGreaterThan(1);

	const readScope = {
		organizationId: organizations_GLOBAL_ORGANIZATION_ID,
		workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	} as const;

	// Full read reproduces the exact committed markdown by merging chunks (no R2 fetch for chunk reads).
	const full = await t.query(internal.files_nodes.read_file_content_from_chunks, {
		...readScope,
		userId: db.userId,
		path,
		mode: { kind: "full", maxBytes: files_get_utf8_byte_size(markdown) + 1000 },
	});
	expect(full).not.toBeNull();
	if (!full) throw new Error("expected external full read");
	expect(full.content).toBe(markdown);
	expect(full.moreLines).toBe(false);
	expect(full.pendingUpdateId).toBeNull();

	// Line read slices the same range as slicing the full committed text.
	const lineRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
		...readScope,
		userId: db.userId,
		path,
		mode: { kind: "lines", startLine: 1, maxLines: 5 },
	});
	expect(lineRead).not.toBeNull();
	if (!lineRead) throw new Error("expected external line read");
	expect(lineRead.content).toBe(files_line_range_from_text(markdown, 1, 5).content);

	// read_committed_file_chunks_line_range: head / deep mid-document / tail each equal direct slicing.
	const totalLines = markdown.split("\n").length;
	const readRange = (startLine: number, maxLines: number, fromEnd = false) =>
		t.query(internal.files_nodes.read_committed_file_chunks_line_range, {
			...readScope,
			userId: db.userId,
			path,
			startLine,
			maxLines,
			fromEnd,
		});
	for (const [startLine, maxLines] of [
		[1, 5],
		[20, 6],
		[Math.max(1, totalLines - 3), 10],
	] as const) {
		const result = await readRange(startLine, maxLines);
		expect(result.usable).toBe(true);
		if (!result.usable) throw new Error("expected usable");
		expect(result.content).toBe(files_line_range_from_text(markdown, startLine, maxLines).content);
	}
	const tail = await readRange(1, 5, true);
	expect(tail.usable).toBe(true);
	if (!tail.usable) throw new Error("expected usable tail");
	expect(tail.content).toBe(files_tail_lines_from_text(markdown, 5).content);

	// Exact counts come from the linked file_stats doc (byteCount from the R2 content asset size).
	const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
		...readScope,
		userId: db.userId,
		path,
	});
	expect(stats.usable).toBe(true);
	if (!stats.usable) throw new Error("expected usable stats");
	expect(stats.lineCount).toBe((markdown.match(/\n/gu) ?? []).length);
	expect(Array.from(markdown).length).toBeLessThan(markdown.length);
	expect(stats.charCount).toBe(Array.from(markdown).length);
	expect(stats.byteCount).toBe(files_get_utf8_byte_size(markdown));
	expect(stats.wordCount).toBe(markdown.trim().split(/\s+/u).length);

	// match_text_file_lines / match_plain_text_file_lines read committed chunks with no pending gate.
	const markdownGrep = await t.query(internal.files_nodes.match_text_file_lines, {
		...readScope,
		userId: db.userId,
		fileNodeId: nodeId,
		pattern: "externalneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(markdownGrep).not.toBeNull();
	if (!markdownGrep) throw new Error("expected external markdown grep");
	expect(markdownGrep.lines.map(({ lineNumber, line }) => ({ lineNumber, line }))).toEqual([
		{ lineNumber: 3, line: "externalneedle one" },
		{ lineNumber: 58, line: "externalneedle two" },
	]);

	const plainGrep = await t.query(internal.files_nodes.match_plain_text_file_lines, {
		...readScope,
		userId: db.userId,
		fileNodeId: nodeId,
		pattern: "critical mount alert",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
	});
	expect(plainGrep).not.toBeNull();
	if (!plainGrep) throw new Error("expected external plain-text grep");
	expect(plainGrep.lines).toEqual([{ lineNumber: 4, line: "critical mount alert", matched: true }]);

	// text_search_files finds committed external content; no pending lookup runs for reserved scope.
	const search = await t.query(internal.files_nodes.text_search_files, {
		...readScope,
		userId: db.userId,
		hasWorkspaceRead: true,
		query: "externalsearchneedle",
		numItems: 10,
		cursor: null,
	});
	expect(search.items.map((item) => item.path)).toContain(path);

	// get_file_last_available_text_content_by_path falls into the raw-R2 `.text()` branch for external.
	const available = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
		...readScope,
		userId: db.userId,
		path,
	});
	expect(available).not.toBeNull();
	if (!available) throw new Error("expected external available content");
	expect(available.content).toBe(markdown);
	expect(available.pendingUpdateId).toBeNull();
});

test("file_stats stay fresh after an edit: re-materialization patches the same doc in place", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Stats Edit User",
		email: "stats-edit-user@example.com",
	});
	const r2Writes = test_setup_r2_capture();

	const markdownA = "# Stats Doc\n\nFirst paragraph alpha.\n\nSecond paragraph beta.";
	const markdownB = `${markdownA}\n\nThird paragraph gamma delta epsilon.\n\nFourth paragraph zeta eta theta iota.`;

	const created = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/stats-edit.md",
	});
	if (created._nay) throw new Error(created._nay.message);
	const nodeId = created._yay.nodeId;

	const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: markdownA });
	if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
	const pushA = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
		sessionId: "stats-edit-A",
	});
	if (pushA._nay) throw new Error(pushA._nay.message);
	const matA = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (matA._nay) throw new Error(matA._nay.message);

	const wc = (text: string) => ({
		lineCount: (text.match(/\n/gu) ?? []).length,
		wordCount: text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length,
		charCount: Array.from(text).length,
		byteCount: files_get_utf8_byte_size(text),
	});
	const statsArgs = {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/stats-edit.md",
	};

	const committedA = await test_read_committed_markdown(t, nodeId, r2Writes);
	if (committedA === undefined) throw new Error("Expected committed A");
	const statsA = await asUser.query(internal.files_nodes.read_committed_file_chunk_stats, statsArgs);
	expect(statsA.usable).toBe(true);
	if (!statsA.usable) throw new Error("expected usable A");
	expect({
		lineCount: statsA.lineCount,
		wordCount: statsA.wordCount,
		charCount: statsA.charCount,
		byteCount: statsA.byteCount,
	}).toEqual(wc(committedA));
	const statsDocIdA = await t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))?.statsId ?? null);
	expect(statsDocIdA).not.toBeNull();

	// Edit: transform the live Yjs doc to B and push only the incremental diff, then re-materialize.
	const svA = encodeStateVector(yjsDoc);
	const updated = files_yjs_doc_update_from_text({ rootKind: "rich_text", text: markdownB, mut_yjsDoc: yjsDoc });
	if (updated._nay) throw new Error(updated._nay.message);
	const pushB = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc, svA)),
		sessionId: "stats-edit-B",
	});
	yjsDoc.destroy();
	if (pushB._nay) throw new Error(pushB._nay.message);
	const matB = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: 2,
	});
	if (matB._nay) throw new Error(matB._nay.message);

	const committedB = await test_read_committed_markdown(t, nodeId, r2Writes);
	if (committedB === undefined) throw new Error("Expected committed B");
	// The edit really changed the content — otherwise the freshness guarantee is not exercised.
	expect(committedB.length).toBeGreaterThan(committedA.length);
	const statsB = await asUser.query(internal.files_nodes.read_committed_file_chunk_stats, statsArgs);
	expect(statsB.usable).toBe(true);
	if (!statsB.usable) throw new Error("expected usable B");
	expect({
		lineCount: statsB.lineCount,
		wordCount: statsB.wordCount,
		charCount: statsB.charCount,
		byteCount: statsB.byteCount,
	}).toEqual(wc(committedB));
	expect(statsB.lineCount).toBeGreaterThan(statsA.lineCount);

	// The same stats doc was patched in place (back-ref unchanged) — no duplicate doc was inserted.
	const statsDocIdB = await t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))?.statsId ?? null);
	expect(statsDocIdB).toBe(statsDocIdA);
	const statsDocCount = await t.run(
		async (ctx) =>
			(
				await ctx.db
					.query("file_stats")
					.withIndex("by_organization_workspace_fileNode", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
					)
					.collect()
			).length,
	);
	expect(statsDocCount).toBe(1);
});

test("text_search_files scopes to a path prefix without sibling-prefix leakage and limits after filtering", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Search User",
		email: "search-user@example.com",
	});
	test_setup_r2_capture();

	const body = (label: string) => `# ${label}\n\nThis document mentions scopeneedle exactly once for ${label}.`;
	// One file under /scope and one under the sibling-prefix folder /scope-other (string-prefix
	// collision). Two files is the per-user push-rate-limit ceiling; the richer multi-candidate
	// limit-after-filter case is covered by the bash search mock test.
	await test_materialize_markdown_file(t, asUser, db, "/scope/inside.md", body("inside"));
	await test_materialize_markdown_file(t, asUser, db, "/scope-other/collide.md", body("collide"));

	const search = (pathPrefix: string | undefined, numItems: number, cursor: string | null = null) =>
		asUser.query(internal.files_nodes.text_search_files, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query: "scopeneedle",
			numItems,
			cursor,
			pathPrefix,
		});

	// Unscoped: both files match.
	const all = await search(undefined, 50);
	expect(new Set(all.items.map((i) => i.path))).toEqual(new Set(["/scope/inside.md", "/scope-other/collide.md"]));

	const firstUnscopedPage = await search(undefined, 1);
	expect(firstUnscopedPage.items).toHaveLength(1);
	expect(firstUnscopedPage.isDone).toBe(false);
	expect(firstUnscopedPage.continueCursor).not.toBe("");
	const secondUnscopedPage = await search(undefined, 50, firstUnscopedPage.continueCursor);
	expect(secondUnscopedPage.isDone).toBe(true);
	expect(new Set([...firstUnscopedPage.items, ...secondUnscopedPage.items].map((i) => i.path))).toEqual(
		new Set(["/scope/inside.md", "/scope-other/collide.md"]),
	);

	// Scoped to /scope: only the file under /scope, NOT the sibling-prefix /scope-other file.
	const scoped = await search("/scope", 50);
	expect(scoped.items.map((i) => i.path)).toEqual(["/scope/inside.md"]);

	// Scoped to the sibling prefix: only its file (the collision is rejected in both directions).
	const scopedOther = await search("/scope-other", 50);
	expect(scopedOther.items.map((i) => i.path)).toEqual(["/scope-other/collide.md"]);

	// Limit applied AFTER the path filter: with limit 1 and an out-of-scope match also present, the
	// single in-scope match is still returned (an out-of-scope match must not consume the limit).
	const scopedTinyLimit = await search("/scope", 1);
	expect(scopedTinyLimit.items.map((i) => i.path)).toEqual(["/scope/inside.md"]);
});

test("text_search_files searches pending unstaged content instead of stale committed chunks", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Pending Search User",
		email: "pending-search-user@example.com",
	});
	test_setup_r2_capture();

	const path = "/pending-search/plan.md";
	const otherPath = "/pending-search/other.md";
	const nodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		path,
		"# Plan\n\ncommittedneedle appears only in the committed version.",
	);
	const otherNodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		otherPath,
		"# Other\n\nsharedneedle lives in another committed file.",
	);

	const search = (query: string) =>
		asUser.query(internal.files_nodes.text_search_files, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query,
			numItems: 10,
			cursor: null,
		});

	const beforePending = await search("committedneedle");
	expect(beforePending.items.map((item) => item.path)).toContain(path);

	const unstagedMarkdown = "# Plan\n\npendingneedle and sharedneedle appear only in the pending version.";
	const pending = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId,
		unstagedMarkdown,
	});
	if (pending._nay) throw new Error(pending._nay.message);

	const otherUserId = await t.run((ctx) =>
		ctx.db.insert("users", {
			clerkUserId: null,
		}),
	);
	const otherUserPending = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: otherUserId,
		nodeId: otherNodeId,
		unstagedMarkdown: "# Other\n\nforeignpendingneedle and sharedneedle are another user's pending content.",
	});
	if (otherUserPending._nay) throw new Error(otherUserPending._nay.message);

	// The pending item carries the real chunk metadata produced by the shared markdown chunker.
	// Chunk the normalized Markdown text that the action stores.
	const expectedChunks = await files_chunk_markdown(normalize_pending_update_markdown(unstagedMarkdown));
	if (expectedChunks._nay) throw new Error(expectedChunks._nay.message);
	const expectedChunk = expectedChunks._yay.find((chunk) => chunk.textChunk.includes("pendingneedle"));
	if (!expectedChunk) throw new Error("Expected a chunk containing pendingneedle");
	await t.run(async (ctx) => {
		const pendingDoc = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_fileNode", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("userId", db.userId)
					.eq("fileNodeId", nodeId),
			)
			.first();
		if (!pendingDoc) throw new Error("Expected pending doc");
		const plainTextChunk = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) =>
				q.eq("pendingUpdateId", pendingDoc._id).eq("chunkIndex", expectedChunk.chunkIndex),
			)
			.first();
		if (!plainTextChunk) throw new Error("Expected pending plain-text chunk");
		expect(plainTextChunk).toMatchObject({
			textChunk: expectedChunk.textChunk,
			startIndex: expectedChunk.startIndex,
			endIndex: expectedChunk.endIndex,
			lineStart: expectedChunk.lineStart,
			lineEnd: expectedChunk.lineEnd,
			chunkFlags: expectedChunk.chunkFlags,
			hasChunkAbove: expectedChunk.chunkIndex > 0,
			hasChunkBelow: expectedChunk.chunkIndex < expectedChunks._yay.length - 1,
		});
		await ctx.db.patch("files_text_chunks", plainTextChunk.textChunkId, {
			textChunk: "stale linked markdown chunk",
			lineStart: 999,
			lineEnd: 999,
		});
	});

	const pendingSearch = await search("pendingneedle");
	expect(pendingSearch.items).toEqual([
		{
			nodeId,
			path,
			textChunk: expectedChunk.textChunk,
			chunkIndex: expectedChunk.chunkIndex,
			startIndex: expectedChunk.startIndex,
			endIndex: expectedChunk.endIndex,
			lineStart: expectedChunk.lineStart,
			lineEnd: expectedChunk.lineEnd,
			chunkFlags: expectedChunk.chunkFlags,
			hasChunkAbove: expectedChunk.chunkIndex > 0,
			hasChunkBelow: expectedChunk.chunkIndex < expectedChunks._yay.length - 1,
		},
	]);
	expect(pendingSearch.isDone).toBe(true);

	// The stale committed chunks of the pending file are hidden.
	const staleCommittedSearch = await search("committedneedle");
	expect(staleCommittedSearch.items.map((item) => item.path)).not.toContain(path);
	expect(staleCommittedSearch.isDone).toBe(true);

	const otherUserCommittedSearch = await asUser.query(internal.files_nodes.text_search_files, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: otherUserId,
		hasWorkspaceRead: true,
		query: "committedneedle",
		numItems: 10,
		cursor: null,
	});
	expect(otherUserCommittedSearch.items.map((item) => item.path)).toContain(path);
	expect(otherUserCommittedSearch.items.map((item) => item.textChunk).join("\n")).not.toContain("pendingneedle");

	const otherPendingSearch = await search("foreignpendingneedle");
	expect(otherPendingSearch.items).toEqual([]);
	expect(otherPendingSearch.isDone).toBe(true);

	// Committed hits from files without this user's pending edits remain visible even when another
	// user has pending chunks for the same file.
	const mergedSearch = await search("sharedneedle");
	expect(new Set(mergedSearch.items.map((item) => item.path))).toEqual(new Set([path, otherPath]));
	const committedOtherItem = mergedSearch.items.find((item) => item.path === otherPath);
	expect(committedOtherItem?.textChunk).toContain("another committed file");
	expect(committedOtherItem?.textChunk).not.toContain("foreignpendingneedle");
	expect(mergedSearch.isDone).toBe(true);
});

test("metadata search indexes committed frontmatter values and scopes by path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Metadata Search User",
		email: "metadata-search-user@example.com",
	});
	test_setup_r2_capture();

	await test_materialize_markdown_file(
		t,
		asUser,
		db,
		"/meta/invoice.md",
		[
			"---",
			"from: alice@example.com",
			"cc:",
			"  - bob@example.com",
			"  - jane@example.com",
			"amount: 120.5",
			"amountString: '120.5'",
			"hasAttachments: true",
			"subject: Invoice reminder",
			"sentAt: 2026-07-29T14:30:00Z",
			"---",
			"Body",
		].join("\n"),
	);
	await test_materialize_markdown_file(
		t,
		asUser,
		db,
		"/meta-other/outside.md",
		["---", "from: alice@example.com", "amount: 300", "sentAt: 2026-06-01", "---", "Outside"].join("\n"),
	);

	const search = (plan: files_metadata_SearchPlan, pathPrefix?: string) =>
		asUser.query(internal.files_metadata.search, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan,
			pathPrefix,
			numItems: 20,
			cursor: null,
		});

	const fromAlice = await search({ op: "eq", qualifiedField: "frontmatter.from", value: "alice@example.com" });
	expect(new Set(fromAlice.items.map((item) => item.path))).toEqual(
		new Set(["/meta/invoice.md", "/meta-other/outside.md"]),
	);

	const copiedToBob = await search({ op: "eq", qualifiedField: "frontmatter.cc", value: "bob@example.com" });
	expect(copiedToBob.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const invoiceSubject = await search({ op: "prefix", qualifiedField: "frontmatter.subject", value: "Invoice" });
	expect(invoiceSubject.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const amountRange = await search({
		op: "range",
		qualifiedField: "frontmatter.amount",
		valueKind: "number",
		gte: 100,
		lt: 200,
	});
	expect(amountRange.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	// Use sentAt to prove that maybe_date companion docs make YAML strings range-searchable.
	const sentInWindow = await search({
		op: "range",
		qualifiedField: "frontmatter.sentAt",
		valueKind: "maybe_date",
		gte: Date.UTC(2026, 6, 27),
		lt: Date.UTC(2026, 7, 2),
	});
	expect(sentInWindow.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const amountStringMismatch = await search({ op: "eq", qualifiedField: "frontmatter.amount", value: "120.5" });
	expect(amountStringMismatch.items).toEqual([]);

	const amountString = await search({ op: "eq", qualifiedField: "frontmatter.amountString", value: "120.5" });
	expect(amountString.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const booleanNumberMismatch = await search({ op: "eq", qualifiedField: "frontmatter.hasAttachments", value: 1 });
	expect(booleanNumberMismatch.items).toEqual([]);

	const hasAttachments = await search({ op: "eq", qualifiedField: "frontmatter.hasAttachments", value: true });
	expect(hasAttachments.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const scoped = await search({ op: "exists", qualifiedField: "frontmatter.from" }, "/meta");
	expect(scoped.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const metadata = await asUser.query(internal.files_metadata.get_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/meta/invoice.md",
	});
	expect(metadata).toMatchObject({
		path: "/meta/invoice.md",
		sourceKind: "committed",
		fields: expect.arrayContaining(["frontmatter.cc", "frontmatter.amountString"]),
		values: expect.arrayContaining([
			expect.objectContaining({ qualifiedField: "frontmatter.amount", valueKind: "number", numberValue: 120.5 }),
			expect.objectContaining({
				qualifiedField: "frontmatter.amountString",
				valueKind: "string",
				stringValue: "120.5",
			}),
			expect.objectContaining({
				qualifiedField: "frontmatter.sentAt",
				valueKind: "string",
				stringValue: "2026-07-29T14:30:00Z",
			}),
			expect.objectContaining({
				qualifiedField: "frontmatter.sentAt",
				valueKind: "maybe_date",
				numberValue: Date.UTC(2026, 6, 29, 14, 30),
			}),
		]),
	});
});

test("metadata search uses current-user pending frontmatter and hides stale committed metadata", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Pending Metadata User",
		email: "pending-metadata-user@example.com",
	});
	test_setup_r2_capture();

	const path = "/meta-pending/message.md";
	const nodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		path,
		[
			"---",
			"from: committed@example.com",
			"subject: Committed subject",
			"sentAt: 2026-06-01",
			"---",
			"Committed body",
		].join("\n"),
	);

	const pending = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId,
		unstagedMarkdown: [
			"---",
			"from: pending@example.com",
			"subject: Pending subject",
			"sentAt: 2026-07-29",
			"---",
			"Pending body",
		].join("\n"),
	});
	if (pending._nay) throw new Error(pending._nay.message);

	const otherUserId = await t.run((ctx) =>
		ctx.db.insert("users", {
			clerkUserId: null,
		}),
	);

	const searchAs = (userId: Id<"users">, value: string) =>
		asUser.query(internal.files_metadata.search, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			plan: { op: "eq", qualifiedField: "frontmatter.from", value },
			numItems: 20,
			cursor: null,
		});

	const pendingHit = await searchAs(db.userId, "pending@example.com");
	expect(pendingHit.items).toMatchObject([{ path, sourceKind: "pending" }]);

	const pendingMetadata = await asUser.query(internal.files_metadata.get_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
	});
	expect(pendingMetadata).toMatchObject({
		path,
		sourceKind: "pending",
		fields: expect.arrayContaining(["frontmatter.from", "frontmatter.subject"]),
		values: expect.arrayContaining([
			expect.objectContaining({
				qualifiedField: "frontmatter.from",
				valueKind: "string",
				stringValue: "pending@example.com",
			}),
		]),
	});

	const staleCommittedMiss = await searchAs(db.userId, "committed@example.com");
	expect(staleCommittedMiss.items).toEqual([]);

	const otherUserCommittedHit = await searchAs(otherUserId, "committed@example.com");
	expect(otherUserCommittedHit.items).toMatchObject([{ path, sourceKind: "committed" }]);

	const otherUserPendingMiss = await searchAs(otherUserId, "pending@example.com");
	expect(otherUserPendingMiss.items).toEqual([]);

	// Include both committed and pending dates in the window. One pending doc then proves the
	// overlay hides the committed doc instead of excluding it by range.
	const dateRangeAs = (userId: Id<"users">) =>
		asUser.query(internal.files_metadata.search, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			plan: {
				op: "range",
				qualifiedField: "frontmatter.sentAt",
				valueKind: "maybe_date",
				gte: Date.UTC(2026, 5, 1),
				lt: Date.UTC(2026, 7, 1),
			},
			numItems: 20,
			cursor: null,
		});

	const pendingDateHit = await dateRangeAs(db.userId);
	expect(pendingDateHit.items).toMatchObject([{ path, sourceKind: "pending" }]);

	const otherUserDateHit = await dateRangeAs(otherUserId);
	expect(otherUserDateHit.items).toMatchObject([{ path, sourceKind: "committed" }]);
});

test("a pure-move row keeps committed metadata visible", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Move Metadata User",
		email: "move-metadata-user@example.com",
	});
	test_setup_r2_capture();

	const path = "/meta-move/message.md";
	const nodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		path,
		["---", "from: committed@example.com", "---", "Committed body"].join("\n"),
	);

	// A pure move row (mv without edits) carries no content and must not mask metadata.
	const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId,
		destParentId: files_ROOT_ID,
		destName: "meta-moved.md",
	});
	if (moved._nay) throw new Error(moved._nay.message);

	const search = () =>
		asUser.query(internal.files_metadata.search, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan: { op: "eq", qualifiedField: "frontmatter.from", value: "committed@example.com" },
			numItems: 20,
			cursor: null,
		});

	// Search still surfaces the file's committed metadata docs.
	const committedHit = await search();
	expect(committedHit.items).toMatchObject([{ path, nodeId, sourceKind: "committed" }]);

	// The get path resolves the visible destination and reports committed metadata.
	const metadata = await asUser.query(internal.files_metadata.get_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/meta-moved.md",
		overlayUserId: db.userId,
	});
	expect(metadata).toMatchObject({
		path: "/meta-moved.md",
		nodeId,
		sourceKind: "committed",
		fields: expect.arrayContaining(["frontmatter.from"]),
		values: expect.arrayContaining([
			expect.objectContaining({
				qualifiedField: "frontmatter.from",
				valueKind: "string",
				stringValue: "committed@example.com",
			}),
		]),
	});

	// A content-bearing row on the same node still overlays the committed metadata.
	const pending = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId,
		unstagedMarkdown: ["---", "from: pending@example.com", "---", "Pending body"].join("\n"),
	});
	if (pending._nay) throw new Error(pending._nay.message);

	const pendingMetadata = await asUser.query(internal.files_metadata.get_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/meta-moved.md",
		overlayUserId: db.userId,
	});
	expect(pendingMetadata).toMatchObject({ sourceKind: "pending" });
	const staleCommittedMiss = await search();
	expect(staleCommittedMiss.items).toEqual([]);
});

test("metadata search updates indexed scope when files are renamed and moved", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Metadata Scope User",
		email: "metadata-scope-user@example.com",
	});
	test_setup_r2_capture();

	const nodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		"/metadata-scope/source.md",
		["---", "scope: metadata-scope-value", "---", "Body"].join("\n"),
	);
	const targetFolderId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "/metadata-target",
			treePath: "/metadata-target/",
			pathDepth: 1,
			lowercaseExtension: null,
			name: "metadata-target",
			kind: "folder",
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: Date.now(),
		}),
	);

	const search = (pathPrefix?: string) =>
		asUser.query(internal.files_metadata.search, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan: { op: "eq", qualifiedField: "frontmatter.scope", value: "metadata-scope-value" },
			pathPrefix,
			numItems: 10,
			cursor: null,
		});

	expect((await search()).items.map((item) => item.path)).toEqual(["/metadata-scope/source.md"]);

	const renamed = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId,
		path: "renamed.md",
	});
	if (renamed._nay) throw new Error(renamed._nay.message);
	expect((await search()).items.map((item) => item.path)).toEqual(["/metadata-scope/renamed.md"]);

	const moved = await asUser.mutation(api.files_nodes.move_nodes, {
		membershipId: db.membershipId,
		itemIds: [nodeId],
		targetParentId: targetFolderId,
	});
	if (moved._nay) throw new Error(moved._nay.message);
	expect((await search()).items.map((item) => item.path)).toEqual(["/metadata-target/renamed.md"]);
	expect((await search("/metadata-scope")).items).toEqual([]);
	expect((await search("/metadata-target")).items.map((item) => item.path)).toEqual(["/metadata-target/renamed.md"]);
});

test("metadata search updates indexed scope when files are archived and unarchived", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Metadata Archive User",
		email: "metadata-archive-user@example.com",
	});
	test_setup_r2_capture();

	const nodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		"/metadata-archive/source.md",
		["---", "scope: metadata-archive-value", "---", "Body"].join("\n"),
	);

	const search = () =>
		asUser.query(internal.files_metadata.search, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan: { op: "eq", qualifiedField: "frontmatter.scope", value: "metadata-archive-value" },
			numItems: 10,
			cursor: null,
		});

	expect((await search()).items.map((item) => item.path)).toEqual(["/metadata-archive/source.md"]);
	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [nodeId],
	});
	if (archived._nay) throw new Error(archived._nay.message);
	expect((await search()).items).toEqual([]);

	const unarchived = await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [nodeId],
	});
	if (unarchived._nay) throw new Error(unarchived._nay.message);
	expect((await search()).items.map((item) => item.path)).toEqual(["/metadata-archive/source.md"]);
});

test("file metadata is searchable next to frontmatter and survives a content save", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "File Metadata User",
		email: "file-metadata-user@example.com",
	});
	test_setup_r2_capture();

	const path = "/file-metadata/note.md";
	const nodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		path,
		["---", "title: From frontmatter", "---", "First body"].join("\n"),
	);

	const written = await asUser.mutation(api.files_metadata.set_entries, {
		membershipId: db.membershipId,
		fileNodeId: nodeId,
		metadataYaml: [
			"title: From metadata",
			"created-by: slack",
			"slack:message-id: '1755500000.001'",
			"priority: 3",
			"archived: false",
			"released-on: 2026-08-18",
		].join("\n"),
	});
	if (written._nay) throw new Error(written._nay.message);

	const entries = () =>
		asUser.query(api.files_metadata.get_entries, { membershipId: db.membershipId, fileNodeId: nodeId });

	// Keys come back in the order they were typed, not in index order.
	expect(await entries()).toEqual([
		{ key: "title", value: "From metadata" },
		{ key: "created-by", value: "slack" },
		{ key: "slack:message-id", value: "1755500000.001" },
		{ key: "priority", value: 3 },
		{ key: "archived", value: false },
		{ key: "released-on", value: "2026-08-18" },
	]);

	const search = (plan: files_metadata_SearchPlan, pathPrefix?: string) =>
		asUser.query(internal.files_metadata.search, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan,
			pathPrefix,
			numItems: 10,
			cursor: null,
		});

	// The same key name on both sources stays two separate fields.
	expect((await search({ op: "eq", qualifiedField: "metadata.title", value: "From metadata" })).items).toMatchObject([
		{ path, nodeId },
	]);
	expect(
		(await search({ op: "eq", qualifiedField: "frontmatter.title", value: "From frontmatter" })).items,
	).toMatchObject([{ path, nodeId }]);
	expect((await search({ op: "eq", qualifiedField: "metadata.title", value: "From frontmatter" })).items).toEqual([]);

	expect((await search({ op: "exists", qualifiedField: "metadata.slack:message-id" })).items).toMatchObject([
		{ path, nodeId },
	]);
	expect(
		(await search({ op: "range", qualifiedField: "metadata.priority", valueKind: "number", gte: 1, lt: 5 })).items,
	).toMatchObject([{ path, nodeId }]);
	expect((await search({ op: "eq", qualifiedField: "metadata.archived", value: false })).items).toMatchObject([
		{ path, nodeId },
	]);
	// A date-like string gets the same maybe_date companion frontmatter gets.
	expect(
		(
			await search({
				op: "range",
				qualifiedField: "metadata.released-on",
				valueKind: "maybe_date",
				gte: Date.UTC(2026, 7, 17),
				lt: Date.UTC(2026, 7, 19),
			})
		).items,
	).toMatchObject([{ path, nodeId }]);

	// Saving the file's content re-indexes its frontmatter. The metadata written next to the file
	// must not be wiped with it.
	const nextYjsDoc = files_yjs_doc_create_from_text({
		rootKind: "rich_text",
		text: ["---", "title: Rewritten frontmatter", "---", "Second body"].join("\n"),
	});
	if ("_nay" in nextYjsDoc) throw new Error(nextYjsDoc._nay.message);
	const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(nextYjsDoc)),
		sessionId: "file-metadata-session",
	});
	nextYjsDoc.destroy();
	if (pushed._nay) throw new Error(pushed._nay.message);
	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: 2,
	});
	if (materialized._nay) throw new Error(materialized._nay.message);

	expect(await entries()).toEqual([
		{ key: "title", value: "From metadata" },
		{ key: "created-by", value: "slack" },
		{ key: "slack:message-id", value: "1755500000.001" },
		{ key: "priority", value: 3 },
		{ key: "archived", value: false },
		{ key: "released-on", value: "2026-08-18" },
	]);
	expect((await search({ op: "eq", qualifiedField: "metadata.title", value: "From metadata" })).items).toMatchObject([
		{ path, nodeId },
	]);
	// Metadata docs carry their own copy of the file's tree path, so folder-scoped search must find
	// them in the file's folder and must not find them under another one.
	expect((await search({ op: "exists", qualifiedField: "metadata.title" }, "/file-metadata")).items).toMatchObject([
		{ path, nodeId },
	]);
	expect((await search({ op: "exists", qualifiedField: "metadata.title" }, "/elsewhere")).items).toEqual([]);

	// The save must also still delete the frontmatter docs it replaces. The push above merges a second
	// Yjs document into the first one, and Yjs orders two concurrent inserts by a random client id, so
	// which frontmatter block ends up on top is not decided here. Exactly one of the two titles must
	// match: two matches would mean the narrowed delete stopped deleting.
	const oldTitle = await search({ op: "eq", qualifiedField: "frontmatter.title", value: "From frontmatter" });
	const newTitle = await search({ op: "eq", qualifiedField: "frontmatter.title", value: "Rewritten frontmatter" });
	expect(oldTitle.items.length + newTitle.items.length).toBe(1);

	// A second write replaces the whole map: the dropped keys stop being searchable.
	const replaced = await asUser.mutation(api.files_metadata.set_entries, {
		membershipId: db.membershipId,
		fileNodeId: nodeId,
		metadataYaml: "title: Only key left\n",
	});
	if (replaced._nay) throw new Error(replaced._nay.message);
	expect(await entries()).toEqual([{ key: "title", value: "Only key left" }]);
	expect((await search({ op: "exists", qualifiedField: "metadata.priority" })).items).toEqual([]);
});

test("file metadata stays visible while a pending content edit hides committed frontmatter", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "File Metadata Pending User",
		email: "file-metadata-pending-user@example.com",
	});
	test_setup_r2_capture();

	const path = "/file-metadata-pending/note.md";
	const nodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		path,
		["---", "from: committed@example.com", "---", "Body"].join("\n"),
	);
	const written = await asUser.mutation(api.files_metadata.set_entries, {
		membershipId: db.membershipId,
		fileNodeId: nodeId,
		metadataYaml: "source: slack\n",
	});
	if (written._nay) throw new Error(written._nay.message);

	const pending = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId,
		unstagedMarkdown: ["---", "from: pending@example.com", "---", "Pending body"].join("\n"),
	});
	if (pending._nay) throw new Error(pending._nay.message);

	const search = (plan: files_metadata_SearchPlan) =>
		asUser.query(internal.files_metadata.search, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan,
			numItems: 10,
			cursor: null,
		});

	// The pending edit replaces what the file's own frontmatter says.
	expect((await search({ op: "eq", qualifiedField: "frontmatter.from", value: "committed@example.com" })).items).toEqual(
		[],
	);
	// It says nothing about the metadata written next to the file, so that stays findable.
	expect((await search({ op: "eq", qualifiedField: "metadata.source", value: "slack" })).items).toMatchObject([
		{ path, nodeId },
	]);

	const metadata = await asUser.query(internal.files_metadata.get_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
		overlayUserId: db.userId,
	});
	// Assert the exact set, not just that the two expected entries are in it. The committed
	// frontmatter doc must be dropped, or `meta get` would print two contradicting frontmatter.from
	// lines, and an arrayContaining assertion would still pass.
	expect(metadata?.sourceKind).toBe("pending");
	expect(metadata?.fields).toEqual(["metadata.source", "frontmatter.from"]);
	expect(metadata?.values.map((value) => [value.qualifiedField, value.stringValue])).toEqual([
		["metadata.source", "slack"],
		["frontmatter.from", "pending@example.com"],
	]);
});

test("set_entries refuses bad YAML, folders, and read-only files", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "File Metadata Refusal User",
		email: "file-metadata-refusal-user@example.com",
	});
	test_setup_r2_capture();

	const nodeId = await test_materialize_markdown_file(t, asUser, db, "/file-metadata-refusal/note.md", "Body\n");
	const setEntries = (fileNodeId: Id<"files_nodes">, metadataYaml: string) =>
		asUser.mutation(api.files_metadata.set_entries, { membershipId: db.membershipId, fileNodeId, metadataYaml });

	expect(await setEntries(nodeId, "title: [unclosed\n")).toMatchObject({
		_nay: { message: expect.stringContaining("valid YAML") },
	});
	expect(await setEntries(nodeId, "owner:\n  name: nested\n")).toMatchObject({
		_nay: { message: expect.stringContaining("must have a text, number, or true/false value") },
	});
	expect(await setEntries(nodeId, "with space: yes\n")).toMatchObject({
		_nay: { message: expect.stringContaining("may contain only letters") },
	});

	const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "metadata-folder",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	expect(await setEntries(folder._yay.nodeId, "title: on a folder\n")).toMatchObject({
		_nay: { message: "Not found" },
	});

	const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
		membershipId: db.membershipId,
		nodeId,
	});
	if (locked._nay) throw new Error(locked._nay.message);
	expect(await setEntries(nodeId, "title: on a locked file\n")).toMatchObject({ _nay: { name: "read_only" } });
	expect(await asUser.query(api.files_metadata.get_entries, { membershipId: db.membershipId, fileNodeId: nodeId })).toEqual(
		[],
	);
});

test("update_entries_by_path lets the agent set and remove keys on an uploaded file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "File Metadata Agent User",
		email: "file-metadata-agent-user@example.com",
	});

	// A binary upload carries metadata too: it lives next to the file, not inside its content.
	const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		filename: "contract.pdf",
		contentType: "application/pdf",
		size: 1234,
	});
	if (upload._nay) throw new Error(upload._nay.message);
	const nodeId = upload._yay.nodeId;
	const path = "/contract.pdf";

	const setByPath = (set: { key: string; value: string | number | boolean }[], remove: string[]) =>
		t.mutation(internal.files_metadata.update_entries_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
			set,
			remove,
		});

	const first = await setByPath(
		[
			{ key: "created-by", value: "agent" },
			{ key: "status", value: "draft" },
			{ key: "pages", value: 12 },
		],
		[],
	);
	if (first._nay) throw new Error(first._nay.message);
	// The upload already stamped where the file came from, and the agent's door only changes the
	// keys it names, so those two keys come first in the list.
	expect(first._yay).toEqual({
		path,
		entries: [
			{ key: "source", value: "upload" },
			{ key: "original-name", value: "contract.pdf" },
			{ key: "created-by", value: "agent" },
			{ key: "status", value: "draft" },
			{ key: "pages", value: 12 },
		],
	});

	// Changing a key keeps its place, removing one drops it, and a new key is appended.
	const second = await setByPath(
		[
			{ key: "status", value: "signed" },
			{ key: "signed-on", value: "2026-08-18" },
		],
		["pages"],
	);
	if (second._nay) throw new Error(second._nay.message);
	expect(second._yay.entries).toEqual([
		{ key: "source", value: "upload" },
		{ key: "original-name", value: "contract.pdf" },
		{ key: "created-by", value: "agent" },
		{ key: "status", value: "signed" },
		{ key: "signed-on", value: "2026-08-18" },
	]);
	expect(await asUser.query(api.files_metadata.get_entries, { membershipId: db.membershipId, fileNodeId: nodeId })).toEqual(
		second._yay.entries,
	);

	expect(
		(
			await asUser.query(internal.files_metadata.search, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				plan: { op: "eq", qualifiedField: "metadata.status", value: "signed" },
				numItems: 10,
				cursor: null,
			})
		).items,
	).toMatchObject([{ path, nodeId }]);

	expect(await setByPath([{ key: "with space", value: "x" }], [])).toMatchObject({
		_nay: { message: expect.stringContaining("may contain only letters") },
	});

	const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
		membershipId: db.membershipId,
		nodeId,
	});
	if (locked._nay) throw new Error(locked._nay.message);
	expect(await setByPath([{ key: "status", value: "tampered" }], [])).toMatchObject({ _nay: { name: "read_only" } });
});

describe("create-time metadata", () => {
	async function read_metadata_docs(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
		return await t.run(async (ctx) =>
			(await ctx.db.query("files_metadata_docs").collect()).filter(
				(doc) => doc.fileNodeId === nodeId && doc.qualifiedField.startsWith("metadata."),
			),
		);
	}

	test("a browser upload stamps its source and the name the client sent", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Upload Metadata User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "quarterly-report.pdf",
			contentType: "application/pdf",
			size: 1234,
		});
		if (upload._nay) throw new Error(upload._nay.message);

		expect(
			await asUser.query(api.files_metadata.get_entries, {
				membershipId: db.membershipId,
				fileNodeId: upload._yay.nodeId,
			}),
		).toEqual([
			{ key: "source", value: "upload" },
			{ key: "original-name", value: "quarterly-report.pdf" },
		]);

		// The publish owns the size and the media type, so the create must stamp neither. Check the
		// stored docs, because the entries above are read back through the same writer that made them.
		expect((await read_metadata_docs(t, upload._yay.nodeId)).map((doc) => doc.qualifiedField).sort()).toEqual([
			"metadata.original-name",
			"metadata.original-name",
			"metadata.source",
			"metadata.source",
		]);

		// The map is searchable straight away, without anybody opening the file.
		expect(
			(
				await asUser.query(internal.files_metadata.search, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					plan: { op: "eq", qualifiedField: "metadata.source", value: "upload" },
					numItems: 10,
					cursor: null,
				})
			).items,
		).toMatchObject([{ path: "/quarterly-report.pdf", nodeId: upload._yay.nodeId }]);
	});

	test("a folder import keeps the relative path and leaves its folders without a map", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Folder Import Metadata User",
		});

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "notes/2026/summary.md", contentType: "text/markdown", size: 12 }],
		});
		if (imported._nay) throw new Error(imported._nay.message);
		const created = imported._yay.created[0];
		if (!created) throw new Error("Expected the import to create one file");

		expect(
			await asUser.query(api.files_metadata.get_entries, {
				membershipId: db.membershipId,
				fileNodeId: created.nodeId,
			}),
		).toEqual([
			{ key: "source", value: "upload" },
			{ key: "original-name", value: "summary.md" },
			{ key: "import-relative-path", value: "notes/2026/summary.md" },
		]);

		// The walk creates two folders on the way to the file. A folder must carry no map, because
		// `set_entries` refuses a node that is not a file. Nobody could ever change or clear a map
		// that sat on a folder.
		const folderIds = await t.run(async (ctx) =>
			(
				await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
					)
					.collect()
			)
				.filter((node) => node.kind === "folder")
				.map((node) => node._id),
		);
		expect(folderIds).toHaveLength(2);
		for (const folderId of folderIds) {
			expect(await read_metadata_docs(t, folderId)).toEqual([]);
		}
	});

	test("an agent eager-created node gets no map and stays hard-deletable", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/eager-metadata.md",
		});
		if (created._nay) throw new Error(created._nay.message);
		if (!created._yay.created || created._yay.createdCommittedSequence === undefined) {
			throw new Error("Expected create_file_by_path to create a fresh node");
		}

		// A stamp here would be permanent: `files_nodes_db_is_eager_node_safe_to_hard_delete` keeps
		// any node that has committed `metadata.` docs, so discarding the proposal would leave the
		// empty file behind forever.
		expect(await read_metadata_docs(t, created._yay.nodeId)).toEqual([]);

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: created._yay.nodeId,
			eagerCreatedCommittedSequence: created._yay.createdCommittedSequence,
		});
		expect(removed._yay.removed).toBe(true);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", created._yay.nodeId)).toBeNull();
		});
	});

	test("the upload publish merges the real size and media type into the create-time keys", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Upload Publish Metadata User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "scan.png",
			contentType: "image/png",
			// The client declares one size. The R2 event below reports another one.
			size: 10,
		});
		if (upload._nay) throw new Error(upload._nay.message);

		const stagingKey = await t.run(
			async (ctx) => (await ctx.db.get("files_r2_assets", upload._yay.assetId))?.uploadStagingR2Key,
		);
		if (!stagingKey) throw new Error("Expected a staged upload asset");

		await t.mutation(internal.r2.process_uploaded_asset_event, {
			assetId: upload._yay.assetId,
			r2Key: r2_create_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: upload._yay.assetId,
			}),
			uploadStagingR2Key: stagingKey,
			size: 2048,
			etag: "etag-upload-properties",
			eventId: "upload-properties-event",
		});

		// The create-time keys survive the publish. Size and media type are not here on purpose: the
		// node and its asset already hold them, and the Properties dialog reads them from there.
		expect(
			await asUser.query(api.files_metadata.get_entries, {
				membershipId: db.membershipId,
				fileNodeId: upload._yay.nodeId,
			}),
		).toEqual([
			{ key: "source", value: "upload" },
			{ key: "original-name", value: "scan.png" },
		]);
	});
});

test("text_search_files scopes pending hits to a path prefix without sibling-prefix leakage", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Pending Scope User",
		email: "pending-scope-user@example.com",
	});
	test_setup_r2_capture();

	const insidePath = "/scope-pending/inside.md";
	const collidePath = "/scope-pending-other/collide.md";
	const insideNodeId = await test_materialize_markdown_file(t, asUser, db, insidePath, "# Inside\n\nbase content.");
	const collideNodeId = await test_materialize_markdown_file(t, asUser, db, collidePath, "# Collide\n\nbase content.");

	for (const [nodeId, label] of [
		[insideNodeId, "Inside"],
		[collideNodeId, "Collide"],
	] as const) {
		const pending = await upsert_pending_update_internal_for_test(t, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			unstagedMarkdown: `# ${label}\n\npendingscopeneedle for ${label}.`,
		});
		if (pending._nay) throw new Error(pending._nay.message);
	}

	const search = (pathPrefix: string | undefined) =>
		asUser.query(internal.files_nodes.text_search_files, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query: "pendingscopeneedle",
			numItems: 10,
			cursor: null,
			pathPrefix,
		});

	const unscoped = await search(undefined);
	expect(new Set(unscoped.items.map((item) => item.path))).toEqual(new Set([insidePath, collidePath]));

	// Scoped to /scope-pending: the sibling-prefix folder must not leak in, and the out-of-scope
	// pending hit must not consume the page.
	const scoped = await search("/scope-pending");
	expect(scoped.items.map((item) => item.path)).toEqual([insidePath]);
	expect(scoped.isDone).toBe(true);

	const scopedOther = await search("/scope-pending-other");
	expect(scopedOther.items.map((item) => item.path)).toEqual([collidePath]);
	expect(scopedOther.isDone).toBe(true);
});

test("text_search_files drops pending hits for archived files", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Pending Archive User",
		email: "pending-archive-user@example.com",
	});
	test_setup_r2_capture();

	const path = "/archive-pending/doc.md";
	const nodeId = await test_materialize_markdown_file(t, asUser, db, path, "# Doc\n\nbase content.");

	const pending = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId,
		unstagedMarkdown: "# Doc\n\narchivedpendingneedle added before archiving.",
	});
	if (pending._nay) throw new Error(pending._nay.message);

	const search = () =>
		asUser.query(internal.files_nodes.text_search_files, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query: "archivedpendingneedle",
			numItems: 10,
			cursor: null,
		});

	const beforeArchive = await search();
	expect(beforeArchive.items.map((item) => item.path)).toEqual([path]);

	// Archive patches denormalized search scope for pending search chunks, so active search excludes it.
	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [nodeId],
	});
	if (archived._nay) throw new Error(archived._nay.message);

	const afterArchive = await search();
	expect(afterArchive.items).toEqual([]);
	expect(afterArchive.isDone).toBe(true);
});

test("text_search_files updates unified search scope when files are renamed and moved", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Search Scope User",
		email: "search-scope-user@example.com",
	});
	test_setup_r2_capture();

	const renameNodeId = await test_insert_searchable_markdown_file(
		t,
		db,
		"/rename-source.md",
		"# Rename\n\nscopecommittedneedle before rename.",
	);
	const moveNodeId = await test_materialize_markdown_file(t, asUser, db, "/move-source.md", "# Move\n\nbase content.");
	const targetFolderId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "/move-target",
			treePath: "/move-target/",
			pathDepth: 1,
			lowercaseExtension: null,
			name: "move-target",
			kind: "folder",
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: Date.now(),
		}),
	);

	const pendingMove = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId: moveNodeId,
		unstagedMarkdown: "# Move\n\nscopependingmoveneedle before move.",
	});
	if (pendingMove._nay) throw new Error(pendingMove._nay.message);

	const search = (query: string, pathPrefix?: string) =>
		asUser.query(internal.files_nodes.text_search_files, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query,
			numItems: 10,
			cursor: null,
			pathPrefix,
		});

	const renamed = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		nodeId: renameNodeId,
		path: "rename-target.md",
	});
	if (renamed._nay) throw new Error(renamed._nay.message);
	expect((await search("scopecommittedneedle")).items.map((item) => item.path)).toEqual(["/rename-target.md"]);

	const moved = await asUser.mutation(api.files_nodes.move_nodes, {
		membershipId: db.membershipId,
		itemIds: [moveNodeId],
		targetParentId: targetFolderId,
	});
	if (moved._nay) throw new Error(moved._nay.message);
	expect((await search("scopependingmoveneedle")).items.map((item) => item.path)).toEqual([
		"/move-target/move-source.md",
	]);
	expect((await search("scopependingmoveneedle", "/move-target")).items.map((item) => item.path)).toEqual([
		"/move-target/move-source.md",
	]);
});

test("text_search_files updates unified committed search scope when files are archived", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Search Archive User",
		email: "search-archive-user@example.com",
	});

	const archiveNodeId = await test_insert_searchable_markdown_file(
		t,
		db,
		"/archive-source.md",
		"# Archive\n\nscopearchivecommittedneedle before archive.",
	);

	const search = (query: string) =>
		asUser.query(internal.files_nodes.text_search_files, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query,
			numItems: 10,
			cursor: null,
		});

	const beforeArchive = await search("scopearchivecommittedneedle");
	expect(beforeArchive.items.map((item) => item.path)).toEqual(["/archive-source.md"]);

	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [archiveNodeId],
	});
	if (archived._nay) throw new Error(archived._nay.message);
	const afterArchive = await search("scopearchivecommittedneedle");
	expect(afterArchive.items).toEqual([]);
	expect(afterArchive.isDone).toBe(true);
});

test("text_search_files paginates unified pending and committed chunks with the native cursor", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Pending Paging User",
		email: "pending-paging-user@example.com",
	});
	test_setup_r2_capture();

	const pendingPath = "/paging/pending.md";
	const committedPath = "/paging/committed.md";
	const pendingNodeId = await test_materialize_markdown_file(t, asUser, db, pendingPath, "# Pending\n\nbase content.");
	await test_materialize_markdown_file(
		t,
		asUser,
		db,
		committedPath,
		"# Committed\n\npagingneedle stays in the committed index.",
	);

	// Two sections that together exceed the chunker max size, so the pending file materializes as
	// two chunk docs that both match the query.
	const section = (label: string) => `# ${label}\n\npagingneedle ${"lorem ipsum dolor sit amet ".repeat(30)}`;
	const unstagedMarkdown = `${section("First")}\n\n${section("Second")}`;
	const pending = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId: pendingNodeId,
		unstagedMarkdown,
	});
	if (pending._nay) throw new Error(pending._nay.message);

	// Chunk the normalized Markdown text that the action stores.
	const expectedChunks = await files_chunk_markdown(normalize_pending_update_markdown(unstagedMarkdown));
	if (expectedChunks._nay) throw new Error(expectedChunks._nay.message);
	expect(expectedChunks._yay).toHaveLength(2);

	const search = (cursor: string | null) =>
		asUser.query(internal.files_nodes.text_search_files, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query: "pagingneedle",
			numItems: 2,
			cursor,
		});

	const firstPage = await search(null);
	expect(firstPage.items).toHaveLength(2);
	expect(firstPage.isDone).toBe(false);
	const parsedCursor = (() => {
		try {
			return JSON.parse(firstPage.continueCursor) as unknown;
		} catch {
			return null;
		}
	})();
	expect(
		Boolean(
			parsedCursor &&
				typeof parsedCursor === "object" &&
				("pendingSkip" in parsedCursor || "pendingDone" in parsedCursor || "committed" in parsedCursor),
		),
	).toBe(false);

	const allItems = [...firstPage.items];
	let cursor = firstPage.continueCursor;
	let sawDone = firstPage.isDone;
	for (let pageGuard = 0; pageGuard < 5 && !sawDone; pageGuard++) {
		const page = await search(cursor);
		allItems.push(...page.items);
		cursor = page.continueCursor;
		sawDone = page.isDone;
	}
	expect(sawDone).toBe(true);
	expect(allItems).toHaveLength(3);
	expect(allItems.map((item) => item.path).filter((path) => path === committedPath)).toHaveLength(1);
	const pendingByChunkIndex = allItems
		.filter((item) => item.path === pendingPath)
		.sort((left, right) => left.chunkIndex - right.chunkIndex);
	expect(pendingByChunkIndex).toHaveLength(2);
	expect(pendingByChunkIndex.map((item) => item.chunkIndex)).toEqual([0, 1]);
	expect(pendingByChunkIndex[0]).toMatchObject({
		textChunk: expectedChunks._yay[0]!.textChunk,
		hasChunkAbove: false,
		hasChunkBelow: true,
	});
	expect(pendingByChunkIndex[1]).toMatchObject({
		textChunk: expectedChunks._yay[1]!.textChunk,
		hasChunkAbove: true,
		hasChunkBelow: false,
	});
});

test("search_content groups readable matches per file for the calling member", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Palette Search User",
		email: "palette-search-user@example.com",
	});
	test_setup_r2_capture();

	// The second file is long enough to split into two committed chunks with the needle in both,
	// so the per-file grouping has something to count.
	const filler = "lorem ipsum dolor sit amet ".repeat(60);
	const singleChunkNodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		"/palette-single.md",
		"# Single\n\nOnly one palneedle lives here.",
	);
	const doubleChunkNodeId = await test_materialize_markdown_file(
		t,
		asUser,
		db,
		"/palette-double.md",
		`# Double\n\nFirst palneedle here.\n\n${filler}\n\nSecond palneedle here.`,
	);

	const found = await asUser.query(api.files_nodes.search_content, {
		membershipId: db.membershipId,
		query: "palneedle",
	});
	const resultsByPath = new Map(found.results.map((result) => [result.path, result]));
	expect([...resultsByPath.keys()].sort()).toEqual(["/palette-double.md", "/palette-single.md"]);
	expect(resultsByPath.get("/palette-single.md")).toMatchObject({ nodeId: singleChunkNodeId, matchCount: 1 });
	expect(resultsByPath.get("/palette-double.md")).toMatchObject({ nodeId: doubleChunkNodeId, matchCount: 2 });
	expect(resultsByPath.get("/palette-single.md")!.textChunk).toContain("palneedle");

	// Bounds: a 1-character query (after trim) and an over-200-character query return empty
	// without touching the search index.
	const tooShort = await asUser.query(api.files_nodes.search_content, {
		membershipId: db.membershipId,
		query: " p ",
	});
	expect(tooShort.results).toEqual([]);
	const tooLong = await asUser.query(api.files_nodes.search_content, {
		membershipId: db.membershipId,
		query: `palneedle ${"x".repeat(200)}`,
	});
	expect(tooLong.results).toEqual([]);

	// No identity is the only hard refusal.
	await expect(
		t.query(api.files_nodes.search_content, { membershipId: db.membershipId, query: "palneedle" }),
	).rejects.toThrow(/Unauthenticated/);
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

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "snapshot-r2.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const nodeId = createdFile._yay.nodeId;
	const { snapshotId } = await t.run(async (ctx) => {
		const r2Key = `content/organizations/${db.organizationId}/workspaces/${db.workspaceId}/nodes/${nodeId}/versions/42/markdown`;
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			r2Key,
			size: files_get_utf8_byte_size(snapshotMarkdown),
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
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
			`content/organizations/${db.organizationId}/workspaces/${db.workspaceId}/nodes/${nodeId}/versions/42/markdown`,
		)}`,
		snapshotId,
	});
	// The signer pins the served type and disposition from the authorized node name. A
	// presigned R2 GET carries no nosniff/CSP, so the pin is the whole defense. A `.md` name is
	// editable text, which never serves inline.
	expect(getUrlSpy).toHaveBeenCalledWith(
		`content/organizations/${db.organizationId}/workspaces/${db.workspaceId}/nodes/${nodeId}/versions/42/markdown`,
		{
			expiresIn: 15 * 60,
			responseContentType: "text/markdown;charset=utf-8",
			responseContentDisposition: "attachment; filename*=UTF-8''snapshot-r2.md",
		},
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

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "missing-snapshot-r2.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const nodeId = createdFile._yay.nodeId;
	const { snapshotId } = await t.run(async (ctx) => {
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			size: 1,
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
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

	const createdFile = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/restore-r2.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const currentMarkdown = "# Current\n\nBefore restore.\n";
	const currentYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: currentMarkdown });
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
	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId: createdFile._yay.nodeId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	const restoredMarkdown = "# Restored\n\nFrom R2 snapshot.\n";
	const { snapshotId } = await t.run(async (ctx) => {
		const snapshotAssetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			size: files_get_utf8_byte_size(restoredMarkdown),
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		const snapshotR2Key = `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${snapshotAssetId}`;
		r2Objects.set(snapshotR2Key, restoredMarkdown);
		await ctx.db.patch("files_r2_assets", snapshotAssetId, { r2Key: snapshotR2Key });
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: createdFile._yay.nodeId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
		});

		return { snapshotId };
	});

	const restoreResult = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		snapshotId,
		sessionId: "restore-r2-session",
	});
	if (restoreResult._nay) {
		throw new Error(restoreResult._nay.message);
	}

	const readResult = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/restore-r2.md",
	});
	expect(readResult?.content).toBe(restoredMarkdown);
	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!fileNode?.assetId) {
			throw new Error("Expected restored node docs");
		}
		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);

		return { asset };
	});
	expect(saved.asset?.size).toBe(files_get_utf8_byte_size(restoredMarkdown));
	// The node now points at a version snapshot with the restored bytes. The backup snapshot
	// still holds the previous version.
	expect(saved.asset?.kind).toBe("content_snapshot");
	expect(r2Objects.get(saved.asset?.r2Key ?? "")).toBe(restoredMarkdown);
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

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "rate-limit.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected owner to create rate-limit file");
	}

	const pushArgs = {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		// Door 1 refuses zero-byte payloads, so use the legal two-byte v1 no-op as the cheap push.
		update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
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
			organizationName: "yjs-rl-ws",
			workspaceName: "yjs-rl-prj",
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
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId),
			)
			.collect();
		const lastSequence = await ctx.db
			.query("files_yjs_docs_last_sequences")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId),
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

	const createdFile = await asAnonymous.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "rate-limit-anonymous.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected anonymous user to create rate-limit file");
	}

	const pushArgs = {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		// Door 1 refuses zero-byte payloads, so use the legal two-byte v1 no-op as the cheap push.
		update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
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

	const createdFile = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
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
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/restore-credit-snapshot`,
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: createdFile._yay.nodeId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
		});

		return { snapshotId, currentSnapshotAssetId, restoredSnapshotAssetId };
	});

	const restoreResult = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
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
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId),
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

test("/api/files/contextual-prompt gives every executed model call a server-owned usage id", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => {
		await ctx.db.patch("users", db.userId, { clerkUserId: "clerk-inline-ai-billing-user" });
		await seed_billing_snapshot_for_user(ctx, db.userId);
	});
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Inline AI Billing User",
		email: "inline-ai-billing-user@example.com",
	});
	generateTextMock.mockResolvedValue({
		text: "Generated text",
		totalUsage: {
			inputTokens: 100,
			outputTokens: 20,
		},
	} as never);
	streamTextMock.mockImplementation(
		(options: {
			onFinish?: (event: { totalUsage: { inputTokens: number; outputTokens: number } }) => PromiseLike<void> | void;
		}) =>
			({
				toUIMessageStreamResponse: async () => {
					await options.onFinish?.({
						totalUsage: {
							inputTokens: 100,
							outputTokens: 20,
						},
					});
					return new Response(null, { status: 200 });
				},
			}) as never,
	);
	vi.spyOn(crypto, "randomUUID")
		.mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
		.mockReturnValueOnce("22222222-2222-4222-8222-222222222222")
		.mockReturnValueOnce("33333333-3333-4333-8333-333333333333")
		.mockReturnValueOnce("44444444-4444-4444-8444-444444444444");
	const requestBody = JSON.stringify({
		prompt: "Improve this text",
		context: {
			beforeSelection: "Before",
			selection: "Selected",
			afterSelection: "After",
		},
		membershipId: db.membershipId,
		requestId: "client_reused_request_id",
	});
	const streamRequestBody = JSON.stringify({
		prompt: "Continue this text",
		membershipId: db.membershipId,
		requestId: "client_reused_request_id",
	});

	const firstResponse = await asUser.fetch("/api/files/contextual-prompt", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: requestBody,
	});
	await t.mutation(components.rate_limiter.lib.resetRateLimit, {
		name: "ai_inline_http",
		key: db.userId,
	});
	const secondResponse = await asUser.fetch("/api/files/contextual-prompt", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: requestBody,
	});
	await t.mutation(components.rate_limiter.lib.resetRateLimit, {
		name: "ai_inline_http",
		key: db.userId,
	});
	const thirdResponse = await asUser.fetch("/api/files/contextual-prompt", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: streamRequestBody,
	});
	await t.mutation(components.rate_limiter.lib.resetRateLimit, {
		name: "ai_inline_http",
		key: db.userId,
	});
	const fourthResponse = await asUser.fetch("/api/files/contextual-prompt", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: streamRequestBody,
	});

	expect(firstResponse.status).toBe(200);
	expect(secondResponse.status).toBe(200);
	expect(thirdResponse.status).toBe(200);
	expect(fourthResponse.status).toBe(200);
	const usageEvents = enqueueActionSpy.mock.calls.map((call) => {
		const args = call[2] as {
			events: Array<{
				externalId: string;
				metadata: { messageId: string };
			}>;
		};
		return args.events[0]!;
	});
	expect(usageEvents.map((event) => event.externalId)).toEqual([
		`ai_usage::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::inline_ai::11111111-1111-4111-8111-111111111111`,
		`ai_usage::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::inline_ai::22222222-2222-4222-8222-222222222222`,
		`ai_usage::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::inline_ai::33333333-3333-4333-8333-333333333333`,
		`ai_usage::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::inline_ai::44444444-4444-4444-8444-444444444444`,
	]);
	expect(usageEvents.map((event) => event.metadata.messageId)).toEqual([
		"client_reused_request_id",
		"client_reused_request_id",
		"client_reused_request_id",
		"client_reused_request_id",
	]);
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

	const createdFile = await asUser.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
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
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/restore-billing-snapshot`,
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: createdFile._yay.nodeId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
		});

		return { snapshotId, currentSnapshotAssetId, restoredSnapshotAssetId };
	});

	// The restore update travels through a trusted stage now; the mutation carries only its id.
	const restoreStage = await t.mutation(internal.files_pending_updates.stage_trusted_yjs_update, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId: createdFile._yay.nodeId,
		kind: "snapshot_restore",
		update: files_u8_to_array_buffer(
			encodeStateAsUpdate(
				(() => {
					const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: restoredMarkdown });
					if ("_nay" in yjsDoc) {
						throw new Error("Expected restored markdown to produce a Yjs doc");
					}

					return yjsDoc;
				})(),
			),
		),
	});
	if (restoreStage._nay) {
		throw new Error(restoreStage._nay.message);
	}
	const restoreResult = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		snapshotId: restoreAssets.snapshotId,
		sessionId: "restore-billing-test",
		snapshotMarkdownContent: restoredMarkdown,
		currentSnapshotAssetId: restoreAssets.currentSnapshotAssetId,
		currentSnapshotSize: 0,
		restoredSnapshotAssetId: restoreAssets.restoredSnapshotAssetId,
		restoredSnapshotSize: files_get_utf8_byte_size(restoredMarkdown),
		restoreUpdateStageId: restoreStage._yay.stageId,
	});
	if (restoreResult._nay) {
		throw new Error(`Expected restore to succeed, got: ${restoreResult._nay.message}`);
	}

	const { asset, yjsUpdates } = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		const asset = fileNode?.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
		return {
			asset,
			yjsUpdates: await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", createdFile._yay.nodeId),
				)
				.collect(),
		};
	});
	expect(yjsUpdates).toHaveLength(1);
	// The restore points the node at the restored version snapshot.
	expect(asset?._id).toBe(restoreAssets.restoredSnapshotAssetId);
	expect(asset).toMatchObject({
		kind: "content_snapshot",
		size: files_get_utf8_byte_size(restoredMarkdown),
	});
	expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
		events: [
			expect.objectContaining({
				name: "file_save",
				externalCustomerId: db.userId,
				externalId: `file_save::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::${createdFile._yay.nodeId}::${yjsUpdates[0]?.sequence}`,
				metadata: expect.objectContaining({
					amount: 1,
					actorUserId: db.userId,
					billedUserId: db.userId,
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
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
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId: files_ROOT_ID,
					name: "retention.md",
					kind: "file",
					path: "/retention.md",
					treePath: "/retention.md",
				}),
			);
			const insertSnapshot = async (label: string, timestamp: string) => {
				vi.setSystemTime(new Date(timestamp));
				return await t.run(async (ctx) => {
					const r2Key = `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${label}`;
					const assetId = await ctx.db.insert("files_r2_assets", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						kind: "content_snapshot",
						r2Bucket: "test-bucket",
						r2Key,
						size: label.length,
						createdBy: db.userId,
						updatedAt: Date.now(),
					});
					const snapshotId = await ctx.db.insert("files_snapshots", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						fileNodeId: nodeId,
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
							.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
								q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
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

describe("external/system mount text materialization (Phase D)", () => {
	// Capture R2 PUT bodies by key so we can assert the single content asset was written and is
	// addressable for hard-delete cleanup (Phase E). Mirrors the snapshot-restore test's capture setup.
	function install_r2_object_capture() {
		const r2Objects = new Map<string, BodyInit>();
		generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
			const key = customKey ?? "test-upload-key";
			return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
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
				return new Response(null, { status: 404 });
			}),
		);
		return r2Objects;
	}

	// Same line/word/char accounting the production materializer applies, replicated locally so the
	// expected file_stats are derived from the source rather than hard-coded.
	function expected_wc_counts(text: string) {
		let lineCount = 0;
		let charCount = 0;
		for (let index = 0; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (code === 10) lineCount++;
			if (code < 0xdc00 || code > 0xdfff) charCount++;
		}
		const trimmed = text.trim();
		const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
		return { lineCount, wordCount, charCount };
	}

	// Markdown-hostile, plus a final line with no trailing newline and a non-ASCII line, to prove the
	// plain-text chunker round-trips raw bytes unchanged (no markdown parsing, no normalization).
	// Stored reserved-scope paths are `/<mount-name>/<rel>` — the `/.mounts` prefix is a bash-VFS mount
	// point only, never persisted (see Phase F prefix knob).
	const MOUNT_FILE_PATH = "/t3-chat/docs/notes.md";
	const MOUNT_RAW_TEXT = [
		"# heading-like but stored as plain text",
		"```ts",
		'const broken = "<unterminated string',
		"| col_a | col_b |",
		"plain Zorptelemetry marker line",
		"\ttab-indented literal not code",
		"",
		"final line with no trailing newline",
	].join("\n");

	test("rejects a mount write atomically after the mount is deleted", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const mountId = await ctx.db.insert("github_mounts", {
				name: "reset-race",
				owner: "owner",
				repo: "repo",
				defaultBranch: "main",
				ref: "main",
				lastCommitSha: null,
				lastTreeSha: null,
				lastSyncedAt: null,
				status: "running",
				startedAt: Date.now(),
				producerFinishedAt: null,
				finishedAt: null,
				lastError: null,
				syncRunId: "reset-race-run",
				pendingCommitSha: "abc123",
			});
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: organizations_GLOBAL_ORGANIZATION_ID,
				workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
				kind: "content",
				r2Bucket: "test-files-bucket",
				size: 4,
				createdBy: users_SYSTEM_AUTHOR,
				updatedAt: Date.now(),
			});
			await ctx.db.delete("github_mounts", mountId);
			return { mountId, assetId };
		});

		const result = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: users_SYSTEM_AUTHOR,
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			parentId: files_ROOT_ID,
			path: "/reset-race/abc123/file.txt",
			contentType: "text/plain;charset=utf-8",
			assetId: seeded.assetId,
			textContent: "test",
			// The mount literal: a read-only file has no Yjs document, so the insert ignores it.
			rootKind: "plain_text",
			readOnly: true,
			mountId: seeded.mountId,
			syncRunId: "reset-race-run",
		});
		expect(result._nay?.message).toBe("External mount sync was superseded");
		expect(await t.run((ctx) => ctx.db.query("files_nodes").first())).toBeNull();
	});

	test("materializes a SYSTEM-authored reserved-scope text node readable byte-identical", async () => {
		const t = test_convex();
		const r2Objects = install_r2_object_capture();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: MOUNT_FILE_PATH,
			rawText: MOUNT_RAW_TEXT,
		});
		if (created._nay) {
			throw new Error(`Expected external text node creation to succeed: ${created._nay.message}`);
		}

		// Full read reconstructs the source exactly (markdown-hostile content, no trailing newline).
		const full = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			path: MOUNT_FILE_PATH,
			mode: { kind: "full", maxBytes: 1_000_000 },
		});
		expect(full?.content).toBe(MOUNT_RAW_TEXT);

		// Line-range read matches the same window computed directly from the source.
		const lineRange = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			path: MOUNT_FILE_PATH,
			mode: { kind: "lines", startLine: 4, maxLines: 2 },
		});
		expect(lineRange?.content).toBe(files_line_range_from_text(MOUNT_RAW_TEXT, 4, 2).content);

		// Exact wc/stat from file_stats (read O(1), not estimated).
		const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			path: MOUNT_FILE_PATH,
		});
		const expectedCounts = expected_wc_counts(MOUNT_RAW_TEXT);
		expect(stats).toMatchObject({
			usable: true,
			lineCount: expectedCounts.lineCount,
			wordCount: expectedCounts.wordCount,
			charCount: expectedCounts.charCount,
			byteCount: files_get_utf8_byte_size(MOUNT_RAW_TEXT),
		});

		// Node + intermediate folders are reserved-scope and SYSTEM-authored; the content asset is keyed
		// (so Phase E hard-delete can clean its R2 object) and holds the exact bytes.
		const docs = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", created._yay.nodeId);
			const asset = fileNode?.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
			const [textChunks, plainTextChunks, metadataDocs, yjsSnapshots, yjsLastSequences] = await Promise.all([
				ctx.db
					.query("files_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
							.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
							.eq("fileNodeId", created._yay.nodeId),
					)
					.collect(),
				ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
							.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
							.eq("fileNodeId", created._yay.nodeId),
					)
					.collect(),
				ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
						q
							.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
							.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
							.eq("fileNodeId", created._yay.nodeId),
					)
					.collect(),
				ctx.db.query("files_yjs_snapshots").collect(),
				ctx.db.query("files_yjs_docs_last_sequences").collect(),
			]);
			const mountFolder = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("path", "/t3-chat")
						.eq("archiveOperationId", undefined),
				)
				.first();
			const docsFolder = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("path", "/t3-chat/docs")
						.eq("archiveOperationId", undefined),
				)
				.first();
			return {
				fileNode,
				asset,
				mountFolder,
				docsFolder,
				textChunks,
				plainTextChunks,
				metadataDocs,
				yjsSnapshots,
				yjsLastSequences,
			};
		});
		expect(docs.fileNode).toMatchObject({
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			kind: "file",
			contentType: "text/plain;charset=utf-8",
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
		});
		expect(docs.fileNode?.yjsSnapshotId).toBeUndefined();
		expect(docs.fileNode?.yjsLastSequenceId).toBeUndefined();
		expect(docs.mountFolder).toMatchObject({
			kind: "folder",
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
		});
		expect(docs.docsFolder).toMatchObject({
			kind: "folder",
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
		});
		expect(docs.asset?.kind).toBe("content");
		expect(docs.asset?.size).toBe(files_get_utf8_byte_size(MOUNT_RAW_TEXT));
		const liveR2Key = docs.asset?.r2Key;
		if (!liveR2Key) {
			throw new Error("Expected external content asset to be keyed");
		}
		expect(r2Objects.get(liveR2Key)).toBe(MOUNT_RAW_TEXT);
		expect(docs.textChunks.map((chunk) => chunk.textChunk).join("")).toBe(MOUNT_RAW_TEXT);
		expect(docs.plainTextChunks.map((chunk) => chunk.plainTextChunk).join("")).toBe(MOUNT_RAW_TEXT);
		expect(docs.textChunks.every((chunk) => chunk.yjsSequence === undefined)).toBe(true);
		expect(docs.plainTextChunks.every((chunk) => chunk.yjsSequence === undefined)).toBe(true);
		// A mount file indexes no frontmatter. Its only entry is the stamp that records where the
		// file came from.
		expect(docs.metadataDocs.map((doc) => doc.qualifiedField)).toEqual(["metadata.source", "metadata.source"]);
		expect(docs.metadataDocs.find((doc) => doc.docKind === "value")?.stringValue).toBe("github-mount");
		expect(docs.yjsSnapshots).toEqual([]);
		expect(docs.yjsLastSequences).toEqual([]);
	});

	// The stamp value is one ternary on the workspace, and the test above only walks the GitHub
	// side of it. Swapping the two words would leave every test green while `meta search` for
	// plugin sources returned mount files instead.
	test("stamps a plugin source file with its own source value", async () => {
		const t = test_convex();
		install_r2_object_capture();

		// The publish stores each file under the version id, the way plugins.publish_version does.
		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
			path: "/plugin_version_1/src/main.ts",
			rawText: "export const main = () => {};",
		});
		if (created._nay) {
			throw new Error(`Expected plugin source node creation to succeed: ${created._nay.message}`);
		}

		const metadataDocs = await t.run(async (ctx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_PLUGINS_WORKSPACE_ID)
						.eq("fileNodeId", created._yay.nodeId),
				)
				.collect(),
		);
		expect(metadataDocs.map((doc) => doc.qualifiedField)).toEqual(["metadata.source", "metadata.source"]);
		expect(metadataDocs.find((doc) => doc.docKind === "value")?.stringValue).toBe("plugin-source");
	});

	test("grep-style line matching maps to raw source line numbers", async () => {
		const t = test_convex();
		install_r2_object_capture();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: MOUNT_FILE_PATH,
			rawText: MOUNT_RAW_TEXT,
		});
		if (created._nay) {
			throw new Error(`Expected external text node creation to succeed: ${created._nay.message}`);
		}

		const plainMatch = await t.query(internal.files_nodes.match_plain_text_file_lines, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			fileNodeId: created._yay.nodeId,
			pattern: "Zorptelemetry",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
		});
		const plainMatchedLines = plainMatch?.lines.filter((line) => line.matched) ?? [];
		expect(plainMatchedLines.map((line) => line.lineNumber)).toEqual([5]);
		expect(plainMatchedLines[0]?.line).toContain("Zorptelemetry");

		const markdownMatch = await t.query(internal.files_nodes.match_text_file_lines, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			fileNodeId: created._yay.nodeId,
			pattern: "Zorptelemetry",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
			before: 0,
			after: 0,
		});
		const markdownMatchedLines = markdownMatch?.lines.filter((line) => line.matched) ?? [];
		expect(markdownMatchedLines.map((line) => line.lineNumber)).toEqual([5]);
	});

	test("search finds external chunks under pathPrefix and stays isolated from tenant scope", async () => {
		const t = test_convex();
		install_r2_object_capture();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: MOUNT_FILE_PATH,
			rawText: MOUNT_RAW_TEXT,
		});
		if (created._nay) {
			throw new Error(`Expected external text node creation to succeed: ${created._nay.message}`);
		}

		const reservedHit = await t.query(internal.files_nodes.text_search_files, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			hasWorkspaceRead: true,
			query: "Zorptelemetry",
			pathPrefix: "/t3-chat",
			numItems: 20,
			cursor: null,
		});
		expect(reservedHit.items.map((item) => item.path)).toContain(MOUNT_FILE_PATH);

		// A real tenant cannot see reserved-scope mount content.
		const tenantMiss = await t.query(internal.files_nodes.text_search_files, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query: "Zorptelemetry",
			numItems: 20,
			cursor: null,
		});
		expect(tenantMiss.items).toEqual([]);
	});

	test("oversize external file is skipped (returns _nay) rather than thrown", async () => {
		const t = test_convex();
		install_r2_object_capture();

		const oversizePath = "/t3-chat/big.txt";
		const result = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: oversizePath,
			rawText: "a".repeat(files_MAX_TEXT_CONTENT_BYTES + 1),
		});
		expect(result._nay).toBeTruthy();

		const leaked = await t.run(async (ctx) => {
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("path", oversizePath)
						.eq("archiveOperationId", undefined),
				)
				.first();
			const assets = await ctx.db
				.query("files_r2_assets")
				.withIndex("by_organization_workspace", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID),
				)
				.collect();
			return { node, assetCount: assets.length };
		});
		expect(leaked.node).toBeNull();
		expect(leaked.assetCount).toBe(0);
	});
});

describe("producer shape pairs", () => {
	// A node born with a `yjsRootKind` that does not match its first Yjs snapshot is invisible to
	// every later guard: no push happened and no structure is wrong. These tests read both sides
	// of the producer's own write, so a born-inconsistent pair fails here.
	test("a writable file node records the shape of the snapshot created beside it", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const markdownContent = "# Producer pair";
		const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_text({
			text: markdownContent,
			rootKind: "rich_text",
		});
		if (snapshotUpdate._nay) {
			throw new Error(`Expected the snapshot creator to succeed: ${snapshotUpdate._nay.message}`);
		}

		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const [assetId, yjsSnapshotAssetId] = await Promise.all([
				ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-files-bucket",
					size: files_get_utf8_byte_size(markdownContent),
					createdBy: db.userId,
					updatedAt: now,
				}),
				ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "yjs_snapshot",
					r2Bucket: "test-files-bucket",
					size: snapshotUpdate._yay.byteLength,
					createdBy: db.userId,
					updatedAt: now,
				}),
			]);
			return { assetId, yjsSnapshotAssetId };
		});

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "/producer-pair.md",
			contentType: "text/markdown;charset=utf-8",
			assetId: seeded.assetId,
			yjsSnapshotAssetId: seeded.yjsSnapshotAssetId,
			textContent: markdownContent,
			rootKind: "rich_text",
			readOnly: false,
		});
		if (created._nay) {
			throw new Error(`Expected writable node creation to succeed: ${created._nay.message}`);
		}

		// Both sides of the pair: the node names the shape, and the snapshot document's only root
		// is the rich text one.
		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", created._yay.nodeId));
		expect(node?.yjsRootKind).toBe("rich_text");

		const snapshotDoc = new YjsDoc();
		applyUpdate(snapshotDoc, new Uint8Array(snapshotUpdate._yay));
		expect([...snapshotDoc.share.keys()]).toEqual([files_YJS_DOC_KEYS.richText]);
	});

	test("a read-only mount node gets no yjsRootKind because it has no Yjs document", async () => {
		const t = test_convex();
		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: "/pair-mount/abc123/data.txt",
			rawText: "plain mount content",
		});
		if (created._nay) {
			throw new Error(`Expected mount node creation to succeed: ${created._nay.message}`);
		}

		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", created._yay.nodeId));
		expect(node?.kind).toBe("file");
		expect(node?.yjsRootKind).toBeUndefined();
	});

	test("a read-only mount chunks to the same boundaries as the pre-slice baseline", async () => {
		const t = test_convex();

		// The deterministic markdown-hostile fixture from `capture-mount-boundary-baseline.mjs`
		// (plain-text-docs planning folder), mirrored here so the test needs no external file.
		// Lines stay far under the 1200-unit chunk cap on purpose: this control must only catch
		// the mount branch being re-routed to the Markdown chunker, never the intended mid-line
		// split of over-cap lines.
		const lines: string[] = [];
		for (let index = 0; index < 120; index++) {
			lines.push(`# heading-like line ${index} but stored as plain text`);
			lines.push("```ts");
			lines.push(`const broken_${index} = "<unterminated string`);
			lines.push(`| col_a_${index} | col_b_${index} |`);
			lines.push(`\ttab-indented literal ${index} not code`);
			lines.push("");
		}
		lines.push("final line with no trailing newline");
		const mountText = lines.join("\n");
		expect(mountText.length).toBe(18445);

		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: "/mount-boundary/abc123/baseline.txt",
			rawText: mountText,
		});
		if (created._nay) {
			throw new Error(`Expected mount node creation to succeed: ${created._nay.message}`);
		}

		const chunks = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!node) {
				throw new Error("Expected the mount node to exist");
			}
			return await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", node.organizationId).eq("workspaceId", node.workspaceId).eq("fileNodeId", node._id),
				)
				.collect();
		});

		// The exact boundaries `mount-boundary-baseline.json` recorded on the pre-change tree
		// (16 chunks over 18,445 chars). A mount routed through the Markdown chunker, or a changed
		// whole-line packing rule, moves these numbers.
		const baselineBoundaries = [
			{ chunkIndex: 0, startIndex: 0, endIndex: 1184, lineStart: 1, lineEnd: 48 },
			{ chunkIndex: 1, startIndex: 1184, endIndex: 2363, lineStart: 49, lineEnd: 94 },
			{ chunkIndex: 2, startIndex: 2363, endIndex: 3563, lineStart: 95, lineEnd: 141 },
			{ chunkIndex: 3, startIndex: 3563, endIndex: 4747, lineStart: 142, lineEnd: 188 },
			{ chunkIndex: 4, startIndex: 4747, endIndex: 5917, lineStart: 189, lineEnd: 234 },
			{ chunkIndex: 5, startIndex: 5917, endIndex: 7106, lineStart: 235, lineEnd: 280 },
			{ chunkIndex: 6, startIndex: 7106, endIndex: 8306, lineStart: 281, lineEnd: 327 },
			{ chunkIndex: 7, startIndex: 8306, endIndex: 9490, lineStart: 328, lineEnd: 374 },
			{ chunkIndex: 8, startIndex: 9490, endIndex: 10660, lineStart: 375, lineEnd: 420 },
			{ chunkIndex: 9, startIndex: 10660, endIndex: 11849, lineStart: 421, lineEnd: 466 },
			{ chunkIndex: 10, startIndex: 11849, endIndex: 13049, lineStart: 467, lineEnd: 513 },
			{ chunkIndex: 11, startIndex: 13049, endIndex: 14233, lineStart: 514, lineEnd: 560 },
			{ chunkIndex: 12, startIndex: 14233, endIndex: 15408, lineStart: 561, lineEnd: 606 },
			{ chunkIndex: 13, startIndex: 15408, endIndex: 16569, lineStart: 607, lineEnd: 650 },
			{ chunkIndex: 14, startIndex: 16569, endIndex: 17742, lineStart: 651, lineEnd: 694 },
			{ chunkIndex: 15, startIndex: 17742, endIndex: 18445, lineStart: 695, lineEnd: 721 },
		];
		const sortedChunks = [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
		expect(
			sortedChunks.map((chunk) => ({
				chunkIndex: chunk.chunkIndex,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
			})),
		).toEqual(baselineBoundaries);
		expect(sortedChunks.map((chunk) => chunk.plainTextChunk).join("")).toBe(mountText);
	});
});

describe("plain text file stats and delete-all", () => {
	/**
	 * Seed an editable plain-text node the way the upload conversion will: the node starts as a
	 * stored upload (whose creation writes the -1 stats sentinel), then gains its Yjs pointers
	 * and `yjsRootKind: "plain_text"` with the content in the stored Yjs snapshot. Committed
	 * chunks and real stats only appear at the first materialization.
	 */
	async function seed_editable_plain_text_upload(args: {
		t: ReturnType<typeof test_convex>;
		asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
		r2Writes: Map<string, BodyInit>;
		filename: string;
		text: string;
	}) {
		const { t, asUser, db, r2Writes, filename, text } = args;
		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename,
			contentType: "text/plain;charset=utf-8",
			size: files_get_utf8_byte_size(text),
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const nodeId = upload._yay.nodeId;

		const plainDoc = files_yjs_doc_create_from_text({ rootKind: "plain_text", text });
		if ("_nay" in plainDoc) {
			throw new Error(plainDoc._nay.message);
		}
		const snapshotBytes = encodeStateAsUpdate(plainDoc);

		await t.run(async (ctx) => {
			const now = Date.now();
			const yjsSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "yjs_snapshot",
				r2Bucket: "test-files-bucket",
				size: snapshotBytes.byteLength,
				createdBy: db.userId,
				updatedAt: now,
			});
			const yjsSnapshotR2Key = r2_create_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: yjsSnapshotAssetId,
			});
			await ctx.db.patch("files_r2_assets", yjsSnapshotAssetId, { r2Key: yjsSnapshotR2Key });
			r2Writes.set(yjsSnapshotR2Key, files_u8_to_array_buffer(snapshotBytes));
			const yjsSnapshotId = await ctx.db.insert("files_yjs_snapshots", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sequence: 0,
				assetId: yjsSnapshotAssetId,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
			});
			const yjsLastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				lastSequence: 0,
				unmaterializedUpdateCount: 0,
				unmaterializedUpdateBytes: 0,
				lineageGeneration: 0,
			});
			await ctx.db.patch("files_nodes", nodeId, {
				yjsSnapshotId,
				yjsLastSequenceId,
				yjsRootKind: "plain_text",
			});
		});

		return { nodeId, plainDoc };
	}

	async function read_file_stats(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
		return await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			return node?.statsId ? await ctx.db.get("file_stats", node.statsId) : null;
		});
	}

	// Objective 18's oracle: the sentinel before the first materialization, exact counts after.
	test("file_stats keeps the -1 sentinel until a plain-text materialization writes exact counts", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Plain Stats User",
		});
		const r2Writes = test_setup_r2_capture();

		const text = "alpha beta\ngamma delta epsilon\n\nzeta\n";
		const { nodeId, plainDoc } = await seed_editable_plain_text_upload({
			t,
			asUser,
			db,
			r2Writes,
			filename: "wc-notes.txt",
			text,
		});
		plainDoc.destroy();

		// Pre-materialization: every count is the -1 unprocessable sentinel from the node's
		// creation; nothing has processed the text yet.
		const statsBefore = await read_file_stats(t, nodeId);
		expect(statsBefore).toMatchObject({ lineCount: -1, wordCount: -1, charCount: -1 });

		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (materialized._nay) {
			throw new Error(materialized._nay.message);
		}

		// Post-materialization: the exact line/word/character counts of the fixture.
		const statsAfter = await read_file_stats(t, nodeId);
		expect(statsAfter).toMatchObject({ lineCount: 4, wordCount: 6, charCount: text.length });
	});

	// Do not refuse a legitimate delete-all: emptied is a normal state, not corruption.
	test("a delete-all on a plain-text file materializes to empty without a refusal", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Plain Delete All User",
		});
		const r2Writes = test_setup_r2_capture();

		const text = "line one\nline two\n";
		const { nodeId, plainDoc } = await seed_editable_plain_text_upload({
			t,
			asUser,
			db,
			r2Writes,
			filename: "delete-all.txt",
			text,
		});

		const firstMaterialize = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (firstMaterialize._nay) {
			throw new Error(firstMaterialize._nay.message);
		}
		const chunkCountBefore = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("files_plain_text_chunks")
						.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
							q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
						)
						.collect()
				).length,
		);
		expect(chunkCountBefore).toBeGreaterThan(0);

		// Empty the file the way the editor does: apply "" through the shape-aware setter and push
		// the diff against the stored lineage.
		const emptiedDoc = files_yjs_doc_clone({ yjsDoc: plainDoc });
		const emptied = files_yjs_doc_update_from_text({ mut_yjsDoc: emptiedDoc, text: "", rootKind: "plain_text" });
		if (emptied._nay) {
			throw new Error(emptied._nay.message);
		}
		const deleteAllDiff = files_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: emptiedDoc,
			yjsBeforeDoc: plainDoc,
		});
		if (!deleteAllDiff) {
			throw new Error("Expected the delete-all to produce a diff update");
		}
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			update: files_u8_to_array_buffer(deleteAllDiff),
			sessionId: "plain-delete-all",
		});
		plainDoc.destroy();
		emptiedDoc.destroy();
		if (pushed._nay) {
			throw new Error(pushed._nay.message);
		}

		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: pushed._yay.newSequence,
		});
		// The named non-refusal: a legitimate delete-all settles as success, never as a shape or
		// content refusal.
		expect(materialized._nay).toBeUndefined();

		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const chunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			const stats = node?.statsId ? await ctx.db.get("file_stats", node.statsId) : null;
			return { node, chunks, stats };
		});
		expect(after.chunks).toEqual([]);
		expect(after.stats).toMatchObject({ lineCount: 0, wordCount: 0, charCount: 0 });
		expect(after.node?.contentShapeMismatchAt).toBeUndefined();
		expect(after.node?.contentTooLargeByteSize).toBeUndefined();
	});
});

// #region door 1 and materialization guards
describe("files_db_yjs_push_update door 1", () => {
	async function create_door_fixture(t: ReturnType<typeof test_convex>, path: string) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		return { db, nodeId: created._yay.nodeId };
	}

	async function read_log_state(
		t: ReturnType<typeof test_convex>,
		db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
		nodeId: Id<"files_nodes">,
	) {
		return await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			return { rowCount: rows.length, lastSequence: lastSequenceDoc?.lastSequence };
		});
	}

	async function push_bytes(
		t: ReturnType<typeof test_convex>,
		db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
		nodeId: Id<"files_nodes">,
		update: Uint8Array,
		rootKind: "rich_text" | "plain_text",
	) {
		return await t.run(async (ctx) => {
			const result = await files_db_yjs_push_update(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				update: files_u8_to_array_buffer(update),
				sessionId: "door-1-test-session",
				userId: db.userId,
				rootKind,
				materializeImmediately: false,
			});
			// `t.run` serializes its return value as a Convex value, and a decode refusal carries a
			// raw Error in `_nay.cause`. Strip to the message the way the registered boundary does.
			return result._nay ? { _nay: { message: result._nay.message } } : result;
		});
	}

	function encoded_attack_state(build: (yjsDoc: YjsDoc) => void) {
		const yjsDoc = new YjsDoc();
		yjsDoc.transact(() => build(yjsDoc));
		return encodeStateAsUpdate(yjsDoc);
	}

	// Control 6's named assertion, all three clauses. The third clause — `lastSequence`
	// unchanged — is what distinguishes "first statement" from "before the insert": a scan
	// placed between the sequence increment and the insert still refuses and still inserts no
	// row, but leaks a bumped sequence on every refusal (control 7).
	test.each([
		{
			title: "a crafted update carrying a child type (ContentType)",
			update: () => encoded_attack_state((d) => d.getXmlFragment("plain_text").insert(0, [new YXmlElement("p")])),
			message: "Update does not match the file shape",
		},
		{
			title: "an embed into an existing root (ContentEmbed)",
			update: () =>
				encoded_attack_state((d) => {
					d.getText("plain_text").insert(0, "base");
					d.getText("plain_text").insertEmbed(2, { x: 1 });
				}),
			message: "Update does not match the file shape",
		},
		{
			title: "a Y.Map named plain_text (ContentAny in a map slot)",
			update: () => encoded_attack_state((d) => d.getMap("plain_text").set("k", "v")),
			message: "Update does not match the file shape",
		},
		{
			title: "a Skip struct merged across a gap",
			update: () => {
				const yjsDoc = new YjsDoc();
				const ytext = yjsDoc.getText("plain_text");
				ytext.insert(0, "a");
				const updateA = encodeStateAsUpdate(yjsDoc);
				ytext.insert(1, "b");
				const stateVectorAfterB = encodeStateVector(yjsDoc);
				ytext.insert(2, "c");
				const updateC = encodeStateAsUpdate(yjsDoc, stateVectorAfterB);
				return mergeUpdates([updateA, updateC]);
			},
			message: "Update does not match the file shape",
		},
		{
			title: "a V2-encoded update",
			update: () => {
				const yjsDoc = new YjsDoc();
				yjsDoc.getText("plain_text").insert(0, "v2 payload");
				return encodeStateAsUpdateV2(yjsDoc);
			},
			message: "Unsupported update encoding",
		},
	])(
		"refuses $title into a plain-text node, inserts no row, and leaves lastSequence unchanged",
		async ({ update, message }) => {
			const t = test_convex();
			const { db, nodeId } = await create_door_fixture(t, `/door-refusal-${Math.random().toString(36).slice(2)}.md`);
			const before = await read_log_state(t, db, nodeId);

			const result = await push_bytes(t, db, nodeId, update(), "plain_text");

			expect(result._nay?.message).toBe(message);
			const after = await read_log_state(t, db, nodeId);
			expect(after.rowCount).toBe(before.rowCount);
			expect(after.lastSequence).toBe(before.lastSequence);
		},
	);

	test("refuses zero bytes before decode with no sequence or update write", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_door_fixture(t, "/door-zero-byte.md");
		const before = await read_log_state(t, db, nodeId);

		const result = await push_bytes(t, db, nodeId, new Uint8Array(0), "plain_text");

		expect(result._nay?.message).toBe("Empty update");
		const after = await read_log_state(t, db, nodeId);
		expect(after.rowCount).toBe(before.rowCount);
		expect(after.lastSequence).toBe(before.lastSequence);
	});

	test("refuses raw bytes over the wire cap before decode with no sequence or update write", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_door_fixture(t, "/door-over-cap.md");
		const before = await read_log_state(t, db, nodeId);

		// Garbage bytes: if the size check did not run before the decode, the refusal would be
		// "Malformed update" instead of the size message. Fill with 0xff — zero-filled bytes
		// decode cleanly as a v1 no-op, which would let the reserve gate's row cap answer
		// "Update too large" even with the pre-decode check gone.
		const result = await push_bytes(
			t,
			db,
			nodeId,
			new Uint8Array(files_MAX_YJS_WIRE_BYTES + 1).fill(255),
			"plain_text",
		);

		expect(result._nay?.message).toBe("Update too large");
		const after = await read_log_state(t, db, nodeId);
		expect(after.rowCount).toBe(before.rowCount);
		expect(after.lastSequence).toBe(before.lastSequence);
	});

	test("stores the canonical two-byte v1 no-op and advances the sequence", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_door_fixture(t, "/door-canonical-noop.md");
		const before = await read_log_state(t, db, nodeId);

		const result = await push_bytes(t, db, nodeId, encodeStateAsUpdate(new YjsDoc()), "plain_text");

		expect(result._nay).toBeUndefined();
		const after = await read_log_state(t, db, nodeId);
		expect(after.rowCount).toBe(before.rowCount + 1);
		expect(after.lastSequence).toBe((before.lastSequence ?? -1) + 1);
	});

	test("accepts a legal plain-text incremental edit", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_door_fixture(t, "/door-legal-edit.md");
		const before = await read_log_state(t, db, nodeId);

		const result = await push_bytes(
			t,
			db,
			nodeId,
			encoded_attack_state((d) => d.getText("plain_text").insert(0, "legal plain text")),
			"plain_text",
		);

		expect(result._nay).toBeUndefined();
		const after = await read_log_state(t, db, nodeId);
		expect(after.rowCount).toBe(before.rowCount + 1);
	});

	test("refuses every writer while a durable repair marker is set on the node", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_door_fixture(t, "/door-marker-refusal.md");
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() });
		});
		const before = await read_log_state(t, db, nodeId);

		const result = await push_bytes(
			t,
			db,
			nodeId,
			encoded_attack_state((d) => d.getText("plain_text").insert(0, "blocked")),
			"plain_text",
		);

		expect(result._nay?.message).toBe("File is not accepting new edits until an operator repairs it");
		const after = await read_log_state(t, db, nodeId);
		expect(after.rowCount).toBe(before.rowCount);
		expect(after.lastSequence).toBe(before.lastSequence);
	});
});

describe("yjs_reserve_and_increment_last_sequence", () => {
	async function create_reserve_fixture(t: ReturnType<typeof test_convex>, path: string) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		return { db, nodeId: created._yay.nodeId };
	}

	test("refuses when the aggregate update-count budget would be crossed and schedules compaction instead of writing", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/reserve-count-budget.md");

		await t.run(async (ctx) => {
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			if (!lastSequenceDoc) {
				throw new Error("Expected a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceDoc._id, {
				unmaterializedUpdateCount: files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
			});
		});

		const result = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				userId: db.userId,
				updateByteLength: 10,
			}),
		);

		expect(result._nay?.message).toBe("File updates are being compacted, retry in a moment");
	});

	test("refuses when the aggregate byte budget would be crossed", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/reserve-byte-budget.md");

		await t.run(async (ctx) => {
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			if (!lastSequenceDoc) {
				throw new Error("Expected a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceDoc._id, {
				unmaterializedUpdateBytes: files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES,
			});
		});

		const result = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				userId: db.userId,
				updateByteLength: 10,
			}),
		);

		expect(result._nay?.message).toBe("File updates are being compacted, retry in a moment");
	});

	test("a budget trip on a settle-marked file returns the repair message instead of retry-in-a-moment", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/reserve-settled-marker.md");

		await t.run(async (ctx) => {
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			if (!lastSequenceDoc) {
				throw new Error("Expected a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceDoc._id, {
				unmaterializedUpdateCount: files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
			});
			// A settled materialization: while the marker is set, compaction completes without
			// advancing the committed content, so the counters can never shrink.
			await ctx.db.patch("files_nodes", nodeId, {
				contentFrontmatterTooLargeFieldCount: files_metadata_MAX_FRONTMATTER_FIELDS + 1,
				contentFrontmatterTooLargeIndexDocumentCount: files_metadata_MAX_FRONTMATTER_FIELDS + 2,
			});
		});
		const jobCountBefore = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("files_content_materialization_jobs")
						.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
						.collect()
				).length,
		);

		const result = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				userId: db.userId,
				updateByteLength: 10,
			}),
		);
		// "Retry in a moment" would be permanently false here; the repair path is the only exit.
		expect(result._nay?.message).toBe("File is not accepting new edits until an operator repairs it");

		// The honest branch enqueues no materialization: it would settle again without freeing budget.
		const jobCountAfter = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("files_content_materialization_jobs")
						.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
						.collect()
				).length,
		);
		expect(jobCountAfter).toBe(jobCountBefore);

		// The too-large-text marker takes the same honest branch.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, {
				contentFrontmatterTooLargeFieldCount: undefined,
				contentFrontmatterTooLargeIndexDocumentCount: undefined,
				contentTooLargeByteSize: files_MAX_TEXT_CONTENT_BYTES + 1,
			});
		});
		const tooLargeResult = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				userId: db.userId,
				updateByteLength: 10,
			}),
		);
		expect(tooLargeResult._nay?.message).toBe("File is not accepting new edits until an operator repairs it");
	});

	test("rejects empty and over-cap rows for the trusted writers too", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/reserve-row-caps.md");

		const emptyResult = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				userId: db.userId,
				updateByteLength: 0,
			}),
		);
		expect(emptyResult._nay?.message).toBe("Empty update");

		const overCapResult = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				userId: db.userId,
				updateByteLength: files_MAX_YJS_WIRE_BYTES + 1,
			}),
		);
		expect(overCapResult._nay?.message).toBe("Update too large");
	});

	test("the public fill writer goes through the same reserve gate", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/reserve-fill-writer.md");

		await t.run(async (ctx) => {
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			if (!lastSequenceDoc) {
				throw new Error("Expected a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceDoc._id, {
				unmaterializedUpdateCount: files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
			});
		});

		// The fill helper throws on a reserve refusal because its earlier writes must roll back.
		await expect(
			t.run(async (ctx) => {
				const fileNode = await ctx.db.get("files_nodes", nodeId);
				if (!files_node_has_editable_yjs_state(fileNode)) {
					throw new Error("Expected an editable file node");
				}
				const contentSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-files-bucket",
					size: 4,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				// The fill update travels through a trusted stage now; the helper carries only its id.
				const fillUpdateStageId = await ctx.db.insert("files_yjs_trusted_update_stages", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					fileNodeId: nodeId,
					kind: "public_fill",
					update: files_u8_to_array_buffer(
						encodeStateAsUpdate(files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "fill" }) as YjsDoc),
					),
					expiresAt: Date.now() + 30 * 60 * 1000,
				});
				return files_nodes_db_fill_text_node_content(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNode,
					userId: db.userId,
					textContent: "fill",
					contentSnapshotAssetId,
					contentSize: 4,
					fillUpdateStageId,
				});
			}),
		).rejects.toThrow(/compacted/);
	});
});

describe("files_nodes.get_file_next_yjs_update", () => {
	async function seed_update_rows(t: ReturnType<typeof test_convex>, sequences: number[]) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: `/next-update-${sequences.join("-")}.md`,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const nodeId = created._yay.nodeId;
		await t.run(async (ctx) => {
			for (const sequence of sequences) {
				await ctx.db.insert("files_yjs_updates", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: nodeId,
					sequence,
					update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
					origin: { type: "USER_EDIT", sessionId: "next-update-seed" },
					createdBy: db.userId,
					createdAt: Date.now(),
				});
			}
		});
		return { db, nodeId };
	}

	test("returns exactly the next row and ignores a concurrent S+1 past the frozen throughSequence", async () => {
		const t = test_convex();
		const { db, nodeId } = await seed_update_rows(t, [1, 2, 3]);

		// The frozen bound is 2; row 3 (the concurrent S+1 push) must be invisible to this run.
		const first = await t.query(internal.files_nodes.get_file_next_yjs_update, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			afterSequence: 0,
			throughSequence: 2,
		});
		expect(first.kind).toBe("row");
		if (first.kind === "row") {
			expect(first.row.sequence).toBe(1);
		}

		const second = await t.query(internal.files_nodes.get_file_next_yjs_update, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			afterSequence: 1,
			throughSequence: 2,
		});
		expect(second.kind).toBe("row");
		if (second.kind === "row") {
			expect(second.row.sequence).toBe(2);
		}

		const done = await t.query(internal.files_nodes.get_file_next_yjs_update, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			afterSequence: 2,
			throughSequence: 2,
		});
		expect(done.kind).toBe("done");
	});

	test("refuses a sequence gap instead of silently skipping it", async () => {
		const t = test_convex();
		const { db, nodeId } = await seed_update_rows(t, [1, 3]);

		const result = await t.query(internal.files_nodes.get_file_next_yjs_update, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			afterSequence: 1,
			throughSequence: 3,
		});
		expect(result).toMatchObject({ kind: "gap", expectedSequence: 2, foundSequence: 3 });
	});
});

describe("materialization guards", () => {
	test("snapshot-size preflight settles the state marker without any GET", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/preflight-no-fetch.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const nodeId = created._yay.nodeId;

		// Pretend the stored Yjs snapshot is over the 4 MiB cap.
		await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(fileNode)) {
				throw new Error("Expected an editable file node");
			}
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
			if (!yjsSnapshotDoc) {
				throw new Error("Expected a Yjs snapshot doc");
			}
			await ctx.db.patch("files_r2_assets", yjsSnapshotDoc.assetId, { size: 5 * 1024 * 1024 });
		});

		const getUrlSpy = vi.spyOn(R2.prototype, "getUrl");
		getUrlSpy.mockClear();
		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});

		expect(materialized._nay?.message).toContain("Yjs state exceeds");
		// No GET happened: the refusal was decided from the stored asset size alone.
		expect(getUrlSpy).not.toHaveBeenCalled();
		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(node?.contentYjsStateTooLargeByteSize).toBe(5 * 1024 * 1024);
	});

	test("the incremental reconstructed-state check settles the marker while applying the log", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/incremental-reconstructed-cap.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const nodeId = created._yay.nodeId;

		// Six legal ~900,000-byte inserts: each wire row stays under the 930,000-byte cap and the
		// aggregate stays under the 8 MiB budget, but the reconstructed state crosses the 4 MiB cap
		// while the rows are applied — the snapshot-size preflight cannot see it (the stored base
		// snapshot is still tiny), so only the incremental check can refuse. Like the door-1
		// fixtures above, the log is built plain-shaped with a test-level `rootKind` shortcut on a
		// Markdown node: only sizes matter here, and the cap runs before any shape logic.
		const yjsDoc = new YjsDoc();
		let lastPushedSequence = 0;
		for (let i = 0; i < 6; i++) {
			const stateVectorBefore = encodeStateVector(yjsDoc);
			yjsDoc.transact(() => {
				const ytext = yjsDoc.getText(files_YJS_DOC_KEYS.plainText);
				ytext.insert(ytext.length, "a".repeat(900_000));
			});
			const update = encodeStateAsUpdate(yjsDoc, stateVectorBefore);
			const pushed = await t.run(async (ctx) => {
				const result = await files_db_yjs_push_update(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					nodeId,
					update: files_u8_to_array_buffer(update),
					sessionId: "incremental-cap-test-session",
					userId: db.userId,
					rootKind: "plain_text",
					materializeImmediately: false,
				});
				return result._nay ? { _nay: { message: result._nay.message } } : result;
			});
			if (pushed._nay) {
				throw new Error(pushed._nay.message);
			}
			lastPushedSequence = pushed._yay.newSequence;
		}

		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: lastPushedSequence,
		});

		expect(materialized._nay?.message).toContain("Yjs state exceeds");
		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(node?.contentYjsStateTooLargeByteSize).toBeGreaterThan(files_MAX_YJS_RECONSTRUCTED_STATE_BYTES);
	});

	test("successful finalization recomputes the aggregate counters exactly", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/finalize-exact-counters.md",
			textContent: "counter fixture\n",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const nodeId = created._yay.nodeId;

		// Drift the counters the way an uncounted legacy file would look. The staleness gate lets
		// only the run whose frozen target equals the current lastSequence finalize, so every
		// covered row is behind the new snapshot and the exact recomputed values here are 0/0.
		await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(fileNode)) {
				throw new Error("Expected an editable file node");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId, {
				unmaterializedUpdateCount: 7,
				unmaterializedUpdateBytes: 999_999,
			});
		});

		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (materialized._nay) {
			throw new Error(materialized._nay.message);
		}

		const lastSequenceDoc = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(fileNode)) {
				throw new Error("Expected an editable file node");
			}
			return await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
		});
		expect(lastSequenceDoc?.unmaterializedUpdateCount).toBe(0);
		expect(lastSequenceDoc?.unmaterializedUpdateBytes).toBe(0);
	});
});
// #endregion door 1 and materialization guards

// #region yjs repair
describe("files_nodes_content.repair_file_yjs_state_from_visible_text", () => {
	test("refuses the default source without a durable marker", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/repair-no-marker.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const result = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: created._yay.nodeId,
			authorUserId: db.userId,
		});
		expect(result._nay?.message).toBe("File carries no durable repair marker");
	});

	test("refuses an author who is not a member of the node's tenant", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/repair-outside-author.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", created._yay.nodeId, { contentShapeMismatchAt: Date.now() });
		});

		// A real user id with no membership in this tenant: the repair must refuse instead of
		// recording a forged author on the new version.
		const outsiderUserId = await t.run(async (ctx) => ctx.db.insert("users", { clerkUserId: null }));
		const result = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: created._yay.nodeId,
			authorUserId: outsiderUserId,
		});
		expect(result._nay?.message).toBe("Not found");
	});

	test("refuses last_committed without the explicit acknowledgement flag", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/repair-no-ack.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const result = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: created._yay.nodeId,
			authorUserId: db.userId,
			source: "last_committed",
		});
		expect(result._nay?.message).toContain("acknowledgement");
	});

	test("refuses a base over the 16 MiB repair cap before any GET", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/repair-over-16mib.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const nodeId = created._yay.nodeId;

		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentYjsStateTooLargeByteSize: 17 * 1024 * 1024 });
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(fileNode)) {
				throw new Error("Expected an editable file node");
			}
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
			if (!yjsSnapshotDoc) {
				throw new Error("Expected a Yjs snapshot doc");
			}
			await ctx.db.patch("files_r2_assets", yjsSnapshotDoc.assetId, { size: 17 * 1024 * 1024 });
		});

		const getUrlSpy = vi.spyOn(R2.prototype, "getUrl");
		getUrlSpy.mockClear();
		const result = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
		});
		expect(result._nay?.message).toContain("repair limit");
		expect(getUrlSpy).not.toHaveBeenCalled();
	});

	test("finalize refuses a stale target sequence, and cleanup durably owns the fresh assets", async () => {
		const t = test_convex();
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/repair-stale-finalize.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const nodeId = created._yay.nodeId;
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() });
		});

		const [yjsSnapshotAssetId, contentSnapshotAssetId, supersededYjsAssetId] = await t.run(async (ctx) => {
			const now = Date.now();
			return await Promise.all([
				ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "yjs_snapshot",
					r2Bucket: "test-files-bucket",
					size: 2,
					createdBy: db.userId,
					unfinalizedExpiresAt: now + 1000,
					updatedAt: now,
				}),
				ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-files-bucket",
					size: 6,
					createdBy: db.userId,
					unfinalizedExpiresAt: now + 1000,
					updatedAt: now,
				}),
				ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "yjs_snapshot",
					r2Bucket: "test-files-bucket",
					size: 2,
					createdBy: db.userId,
					updatedAt: now,
				}),
			]);
		});

		// The file advanced past the repair's frozen target: the final mutation must refuse.
		const finalized = await t.mutation(internal.files_nodes_content.finalize_file_yjs_repair, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
			source: "latest_state",
			acknowledgeDiscardUnmaterialized: false,
			targetSequence: 999,
			expectedLineageGeneration: 0,
			text: "stale.",
			textByteSize: files_get_utf8_byte_size("stale."),
			yjsSnapshotAssetId,
			yjsSnapshotSize: 2,
			contentSnapshotAssetId,
			supersededYjsAssetId,
		});
		expect(finalized._nay?.message).toBe("Stale repair: the file advanced");

		// The refused fresh uploads move to durable cleanup; the node's real assets are untouched.
		await t.mutation(internal.files_nodes_content.delete_unfinalized_repair_assets, {
			assetIds: [yjsSnapshotAssetId, contentSnapshotAssetId],
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", contentSnapshotAssetId)).toBeNull();
		});
		const cleanupJobs = await read_deletion_jobs(t);
		expect(cleanupJobs.map((job) => job.reason)).toEqual(["failed_create", "failed_create"]);
		expect(cleanupJobs.map((job) => job.r2Key).sort()).toEqual(
			expected_ledger_keys(db, [yjsSnapshotAssetId, contentSnapshotAssetId]),
		);
		expect(deleteObjectSpy).not.toHaveBeenCalled();
	});

	test("default repair rebuilds the document from its visible text, bumps the lineage, clears markers, and records the author", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const r2Writes = new Map<string, BodyInit>();
		generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
			const key = customKey ?? "test-upload-key";
			return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
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

		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/repair-happy-path.md",
			textContent: "# Repair me\n\nBody text\n",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const nodeId = created._yay.nodeId;

		// Materialize once so the Yjs snapshot bytes exist in (mocked) R2.
		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (materialized._nay) {
			throw new Error(materialized._nay.message);
		}

		// Poison: pretend materialization refused durably.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() });
		});

		// Capture the pre-repair committed content asset: it must survive the repair because the
		// older files_snapshots history row owns it and old-version restore reads it back.
		const preRepairAssetId = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!node?.assetId) {
				throw new Error("Expected a committed content asset before the repair");
			}
			return node.assetId;
		});

		const repaired = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
		});
		if (repaired._nay) {
			throw new Error(repaired._nay.message);
		}
		expect(repaired._yay.lineageGeneration).toBe(1);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected the repaired node to stay editable");
			}
			// Markers cleared, author recorded.
			expect(node.contentShapeMismatchAt).toBeUndefined();
			expect(node.contentYjsStateTooLargeByteSize).toBeUndefined();
			expect(node.updatedBy).toBe(db.userId);

			// The lineage generation advanced and the counters were reset.
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
			expect(lastSequenceDoc?.lineageGeneration).toBe(1);
			expect(lastSequenceDoc?.unmaterializedUpdateCount).toBe(0);
			expect(lastSequenceDoc?.unmaterializedUpdateBytes).toBe(0);

			// The newest version snapshot is the repair's content asset, authored by the repair author.
			const newestSnapshot = await ctx.db
				.query("files_snapshots")
				.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", nodeId)
						.eq("archivedAt", -1),
				)
				.order("desc")
				.first();
			expect(newestSnapshot?.assetId).toBe(node.assetId);
			expect(newestSnapshot?.createdBy).toBe(db.userId);

			// Retention: the superseded content asset and its object key survive for old-version
			// restore; only the superseded Yjs asset is removed by the cleanup continuation.
			const preRepairAsset = await ctx.db.get("files_r2_assets", preRepairAssetId);
			expect(preRepairAsset).not.toBeNull();
			expect(preRepairAsset?.r2Key).toBeTruthy();

			// Committed chunks were replaced with the repaired plain text.
			const chunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			expect(chunks.length).toBeGreaterThan(0);
			expect(chunks.map((chunk) => chunk.plainTextChunk).join("")).toContain("Repair me");
		});
	});

	// Seed a file whose frontmatter marker settled: create, materialize once (so the Yjs snapshot
	// bytes exist in mocked R2), push over-cap frontmatter, and materialize again so the marker
	// pair lands. Returns the node id and the live over-cap doc for follow-up diff pushes.
	async function seed_frontmatter_marked_file(
		t: ReturnType<typeof test_convex>,
		asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>,
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>,
		path: string,
	) {
		const created = await asUser.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const nodeId = created._yay.nodeId;
		const seededMaterialize = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (seededMaterialize._nay) {
			throw new Error(seededMaterialize._nay.message);
		}

		const overCapMarkdown = `---\n${Array.from({ length: files_metadata_MAX_FRONTMATTER_FIELDS + 1 }, (_, index) => `field_${index}: ${index}`).join("\n")}\n---\n\n# Body\n`;
		const overCapYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: overCapMarkdown });
		if ("_nay" in overCapYjsDoc) {
			throw new Error(overCapYjsDoc._nay.message);
		}
		const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(overCapYjsDoc)),
			sessionId: "frontmatter-repair-session",
		});
		if (pushResult._nay) {
			throw new Error(pushResult._nay.message);
		}
		const settled = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: pushResult._yay.newSequence,
		});
		expect(settled._nay).toMatchObject({ message: "Frontmatter exceeds the index caps" });

		return { nodeId, overCapYjsDoc };
	}

	test("a frontmatter-marked file repairs from latest_state; still-over-cap frontmatter keeps the marker pair and skips the metadata index", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Frontmatter Repair User",
		});
		test_setup_r2_capture();

		const { nodeId, overCapYjsDoc } = await seed_frontmatter_marked_file(t, asUser, db, "/repair-frontmatter-over.md");
		overCapYjsDoc.destroy();

		// The frontmatter marker alone qualifies for the default source: no acknowledgement flag.
		const repaired = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
		});
		if (repaired._nay) {
			throw new Error(repaired._nay.message);
		}
		expect(repaired._yay.lineageGeneration).toBe(1);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected the repaired node to stay editable");
			}
			// The visible text still carries over-cap frontmatter, so the marker pair stays set
			// with the fresh counts. Clearing it would hide the deliberately empty metadata index.
			expect(node.contentFrontmatterTooLargeFieldCount).toBe(files_metadata_MAX_FRONTMATTER_FIELDS + 1);
			expect(node.contentFrontmatterTooLargeIndexDocumentCount).toBeGreaterThan(
				files_metadata_MAX_FRONTMATTER_FIELDS + 1,
			);

			// The deadlock is resolved: the counters reset, so the user can push the fitting edit.
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
			expect(lastSequenceDoc?.lineageGeneration).toBe(1);
			expect(lastSequenceDoc?.unmaterializedUpdateCount).toBe(0);
			expect(lastSequenceDoc?.unmaterializedUpdateBytes).toBe(0);

			// The chunks hold the newest text (the repair is lossless) while the metadata index
			// stays empty instead of throwing the insert helper's over-cap backstop.
			const chunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			expect(chunks.map((chunk) => chunk.plainTextChunk).join("")).toContain("Body");
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode_qualifiedField", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", nodeId),
				)
				.collect();
			expect(metadataDocs).toHaveLength(0);
		});
	});

	test("a frontmatter-marked file whose newest text fits repairs from latest_state and clears the marker pair", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Frontmatter Repair Fits User",
		});
		test_setup_r2_capture();

		const { nodeId, overCapYjsDoc } = await seed_frontmatter_marked_file(t, asUser, db, "/repair-frontmatter-fits.md");

		// The user reduced the frontmatter, but the marker still stands because the fitting
		// push's materialization has not run (convex-test never runs scheduled functions; in
		// production this is the budget-tripped state where that materialization cannot help).
		const fittingDoc = files_yjs_doc_clone({ yjsDoc: overCapYjsDoc });
		const fitted = files_yjs_doc_update_from_text({
			mut_yjsDoc: fittingDoc,
			text: "---\ntitle: Kept\n---\n\n# Small again\n",
			rootKind: "rich_text",
		});
		if (fitted._nay) {
			throw new Error(fitted._nay.message);
		}
		const fittingDiff = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: fittingDoc, yjsBeforeDoc: overCapYjsDoc });
		if (!fittingDiff) {
			throw new Error("Expected the fitting content to produce a diff update");
		}
		const fittingPush = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			update: files_u8_to_array_buffer(fittingDiff),
			sessionId: "frontmatter-repair-session",
		});
		overCapYjsDoc.destroy();
		fittingDoc.destroy();
		if (fittingPush._nay) {
			throw new Error(fittingPush._nay.message);
		}

		const repaired = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
		});
		if (repaired._nay) {
			throw new Error(repaired._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			// The repaired text's frontmatter fits, so the marker pair clears and the metadata
			// index is rebuilt.
			expect(node?.contentFrontmatterTooLargeFieldCount).toBeUndefined();
			expect(node?.contentFrontmatterTooLargeIndexDocumentCount).toBeUndefined();
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode_qualifiedField", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", nodeId),
				)
				.collect();
			expect(metadataDocs.some((doc) => doc.qualifiedField.includes("title"))).toBe(true);

			const chunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			expect(chunks.map((chunk) => chunk.plainTextChunk).join("")).toContain("Small again");
		});
	});
});
// #endregion yjs repair

describe("files_nodes.yjs_prepare_doc_last_snapshot", () => {
	test("returns the resolved yjsRootKind beside the snapshot", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(
			async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
		);
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/prepare-root-kind.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Prepare Root Kind User",
			email: "prepare-root-kind@example.com",
		});
		const prepared = await asUser.action(api.files_nodes.yjs_prepare_doc_last_snapshot, {
			membershipId: db.membershipId,
			nodeId: created._yay.nodeId,
		});
		// A node written before the field existed resolves to rich_text; the response value is
		// required, never absent.
		expect(prepared?.yjsRootKind).toBe("rich_text");
	});
});

/**
 * A small tree for the read-only pointer tests:
 * /outer, /outer/inner, /outer/inner/deep, /outer/sibling, plus /outer/frozen archived before any
 * lock exists, so the cascade tests can prove archived descendants are covered too.
 */
async function seed_read_only_lock_tree(t: ReturnType<typeof test_convex>) {
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Read Only Test User",
	});

	const outer = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "outer",
	});
	if (outer._nay) {
		throw new Error(outer._nay.message);
	}
	const inner = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: outer._yay.nodeId,
		path: "inner",
	});
	if (inner._nay) {
		throw new Error(inner._nay.message);
	}
	const deep = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: inner._yay.nodeId,
		path: "deep",
	});
	if (deep._nay) {
		throw new Error(deep._nay.message);
	}
	const sibling = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: outer._yay.nodeId,
		path: "sibling",
	});
	if (sibling._nay) {
		throw new Error(sibling._nay.message);
	}
	const frozen = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: outer._yay.nodeId,
		path: "frozen",
	});
	if (frozen._nay) {
		throw new Error(frozen._nay.message);
	}
	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [frozen._yay.nodeId],
	});
	if (archived._nay) {
		throw new Error(archived._nay.message);
	}

	return {
		db,
		asUser,
		outerId: outer._yay.nodeId,
		innerId: inner._yay.nodeId,
		deepId: deep._yay.nodeId,
		siblingId: sibling._yay.nodeId,
		frozenId: frozen._yay.nodeId,
	};
}

/**
 * Create an archived `/docs` tree with a locked, restricted child, then create a new active
 * `/docs` tree. The two roots share paths but not parent lineage.
 */
async function seed_reused_read_only_path_tree(t: ReturnType<typeof test_convex>) {
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Read Only Path Reuse Owner",
	});

	const archivedRoot = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "docs",
	});
	if (archivedRoot._nay) {
		throw new Error(archivedRoot._nay.message);
	}
	const archivedChild = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: archivedRoot._yay.nodeId,
		path: "secret",
	});
	if (archivedChild._nay) {
		throw new Error(archivedChild._nay.message);
	}
	const restricted = await asUser.mutation(api.files_sharing.restrict_node, {
		membershipId: db.membershipId,
		nodeId: archivedChild._yay.nodeId,
	});
	if (restricted._nay) {
		throw new Error(restricted._nay.message);
	}
	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [archivedRoot._yay.nodeId],
	});
	if (archived._nay) {
		throw new Error(archived._nay.message);
	}
	await set_read_only_or_throw(asUser, db.membershipId, archivedChild._yay.nodeId);

	const activeRoot = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "docs",
	});
	if (activeRoot._nay) {
		throw new Error(activeRoot._nay.message);
	}
	const activeChild = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: activeRoot._yay.nodeId,
		path: "current",
	});
	if (activeChild._nay) {
		throw new Error(activeChild._nay.message);
	}
	const target = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "target",
	});
	if (target._nay) {
		throw new Error(target._nay.message);
	}

	return {
		db,
		asUser,
		archivedRootId: archivedRoot._yay.nodeId,
		archivedChildId: archivedChild._yay.nodeId,
		activeRootId: activeRoot._yay.nodeId,
		activeChildId: activeChild._yay.nodeId,
		targetId: target._yay.nodeId,
	};
}

function read_lock_node(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
	return t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
}

describe("files_nodes.set_node_read_only", () => {
	test("locks a folder and cascades over active and archived descendants", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId, frozenId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();

		const outer = await read_lock_node(t, outerId);
		expect(outer?.readOnlyScopeNodeId).toBe(outerId);

		for (const nodeId of [innerId, deepId, siblingId]) {
			const node = await read_lock_node(t, nodeId);
			expect(node?.readOnlyScopeNodeId).toBe(outerId);
		}

		// The archived child is repointed too: a folder lock covers archived descendants (RO-05).
		const frozen = await read_lock_node(t, frozenId);
		expect(frozen?.archiveOperationId).toBeDefined();
		expect(frozen?.readOnlyScopeNodeId).toBe(outerId);
	});

	test("a nested explicit lock keeps its own pointer and the cascade stops there", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId } = await seed_read_only_lock_tree(t);

		const innerLocked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(innerLocked._nay).toBeUndefined();
		const outerLocked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(outerLocked._nay).toBeUndefined();

		const outer = await read_lock_node(t, outerId);
		expect(outer?.readOnlyScopeNodeId).toBe(outerId);
		const sibling = await read_lock_node(t, siblingId);
		expect(sibling?.readOnlyScopeNodeId).toBe(outerId);

		// The nested explicit root and its subtree keep their own pointer.
		const inner = await read_lock_node(t, innerId);
		expect(inner?.readOnlyScopeNodeId).toBe(innerId);
		const deep = await read_lock_node(t, deepId);
		expect(deep?.readOnlyScopeNodeId).toBe(innerId);
	});

	test("an inherited node may take its own explicit lock that survives the outer unlock", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId } = await seed_read_only_lock_tree(t);

		const outerLocked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(outerLocked._nay).toBeUndefined();
		const innerLocked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(innerLocked._nay).toBeUndefined();

		// The inherited node's pointer becomes itself, and its subtree repoints at it.
		const innerAfterLock = await read_lock_node(t, innerId);
		expect(innerAfterLock?.readOnlyScopeNodeId).toBe(innerId);
		const deepAfterLock = await read_lock_node(t, deepId);
		expect(deepAfterLock?.readOnlyScopeNodeId).toBe(innerId);

		const outerUnlocked = await asUser.mutation(api.files_nodes.set_node_writable, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(outerUnlocked._nay).toBeUndefined();

		const outer = await read_lock_node(t, outerId);
		expect(outer?.readOnlyScopeNodeId).toBeUndefined();
		const sibling = await read_lock_node(t, siblingId);
		expect(sibling?.readOnlyScopeNodeId).toBeUndefined();

		// The direct lock survives the outer unlock.
		const inner = await read_lock_node(t, innerId);
		expect(inner?.readOnlyScopeNodeId).toBe(innerId);
		const deep = await read_lock_node(t, deepId);
		expect(deep?.readOnlyScopeNodeId).toBe(innerId);
	});

	test("locking is idempotent", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();
		const lockedAgain = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(lockedAgain._nay).toBeUndefined();

		const outer = await read_lock_node(t, outerId);
		expect(outer?.readOnlyScopeNodeId).toBe(outerId);
		const inner = await read_lock_node(t, innerId);
		expect(inner?.readOnlyScopeNodeId).toBe(outerId);
	});

	test("locks an archived explicit root", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Test User",
		});

		const cold = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "cold",
		});
		if (cold._nay) {
			throw new Error(cold._nay.message);
		}
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [cold._yay.nodeId],
		});
		expect(archived._nay).toBeUndefined();

		const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: cold._yay.nodeId,
		});
		expect(locked._nay).toBeUndefined();

		const coldNode = await read_lock_node(t, cold._yay.nodeId);
		expect(coldNode?.readOnlyScopeNodeId).toBe(cold._yay.nodeId);
	});

	test("locking a new active folder ignores a restricted archived tree with the same path", async () => {
		const t = test_convex();
		const { db, asUser, archivedChildId, activeRootId, activeChildId } =
			await seed_reused_read_only_path_tree(t);
		const manager = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_read_only_path_reuse_manager" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			return { userId, membershipId };
		});
		const role = await asUser.mutation(api.access_control.create_role, {
			organizationId: db.organizationId,
			name: "Path Reuse Lock Manager",
			description: "",
			permissions: ["content.read", "content.write", "content.permissions.manage"],
		});
		if (role._nay) {
			throw new Error(role._nay.message);
		}
		const assigned = await asUser.mutation(api.access_control.set_user_role, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: manager.userId,
			role: role._yay.roleId,
		});
		if (assigned._nay) {
			throw new Error(assigned._nay.message);
		}
		const asManager = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: manager.userId,
			name: "Read Only Path Reuse Manager",
		});

		const locked = await asManager.mutation(api.files_nodes.set_node_read_only, {
			membershipId: manager.membershipId,
			nodeId: activeRootId,
		});
		expect(locked._nay).toBeUndefined();
		expect((await read_lock_node(t, activeRootId))?.readOnlyScopeNodeId).toBe(activeRootId);
		expect((await read_lock_node(t, activeChildId))?.readOnlyScopeNodeId).toBe(activeRootId);
		expect((await read_lock_node(t, archivedChildId))?.readOnlyScopeNodeId).toBe(archivedChildId);
	});
});

describe("files_nodes.set_node_writable", () => {
	test("unlocks an explicit root and clears the subtree", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId, frozenId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();
		const unlocked = await asUser.mutation(api.files_nodes.set_node_writable, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(unlocked._nay).toBeUndefined();

		// Every affected node, including the archived child, is writable again.
		for (const nodeId of [outerId, innerId, deepId, siblingId, frozenId]) {
			const node = await read_lock_node(t, nodeId);
			expect(node?.readOnlyScopeNodeId).toBeUndefined();
		}
	});

	test("unlocking an explicit root under an outer lock falls back to the outer pointer", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId } = await seed_read_only_lock_tree(t);

		for (const nodeId of [outerId, innerId]) {
			const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
				membershipId: db.membershipId,
				nodeId,
			});
			expect(locked._nay).toBeUndefined();
		}
		const unlocked = await asUser.mutation(api.files_nodes.set_node_writable, {
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(unlocked._nay).toBeUndefined();

		// The direct lock is gone, but the outer lock still covers the subtree, so the node stays
		// effectively read-only through the inherited pointer.
		const inner = await read_lock_node(t, innerId);
		expect(inner?.readOnlyScopeNodeId).toBe(outerId);
		const deep = await read_lock_node(t, deepId);
		expect(deep?.readOnlyScopeNodeId).toBe(outerId);
	});

	test("unlocking an inherited node is refused and changes nothing", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();

		const refused = await asUser.mutation(api.files_nodes.set_node_writable, {
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(refused._nay?.message).toBe("This is not directly read-only");

		const inner = await read_lock_node(t, innerId);
		expect(inner?.readOnlyScopeNodeId).toBe(outerId);

		// Use the same path to prove the direct lock can be removed.
		const unlocked = await asUser.mutation(api.files_nodes.set_node_writable, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(unlocked._nay).toBeUndefined();
	});

	test("unlocking a writable node is an idempotent no-op", async () => {
		const t = test_convex();
		const { db, asUser, siblingId } = await seed_read_only_lock_tree(t);

		const unlocked = await asUser.mutation(api.files_nodes.set_node_writable, {
			membershipId: db.membershipId,
			nodeId: siblingId,
		});
		expect(unlocked._nay).toBeUndefined();

		const sibling = await read_lock_node(t, siblingId);
		expect(sibling?.readOnlyScopeNodeId).toBeUndefined();
	});

	test("locks and unlocks an archived root", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Test User",
		});

		const cold = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "cold",
		});
		if (cold._nay) {
			throw new Error(cold._nay.message);
		}
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [cold._yay.nodeId],
		});
		expect(archived._nay).toBeUndefined();

		const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: cold._yay.nodeId,
		});
		expect(locked._nay).toBeUndefined();
		const unlocked = await asUser.mutation(api.files_nodes.set_node_writable, {
			membershipId: db.membershipId,
			nodeId: cold._yay.nodeId,
		});
		expect(unlocked._nay).toBeUndefined();

		const coldNode = await read_lock_node(t, cold._yay.nodeId);
		expect(coldNode?.readOnlyScopeNodeId).toBeUndefined();
	});
});

describe("files_node_require_writable", () => {
	test("a node with no pointer is writable", () => {
		expect(files_node_require_writable({ readOnlyScopeNodeId: undefined })._nay).toBeUndefined();
	});

	test("a locked node refuses with the stable read_only classification", () => {
		const refused = files_node_require_writable({
			readOnlyScopeNodeId: "read_only_scope_node" as Id<"files_nodes">,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
	});
});

describe("new-node read-only inheritance", () => {
	test("a normal creation starts unlocked", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Test User",
		});

		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "fresh",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		// Normal tenant creation starts unlocked: only a named migration/repair caller may opt
		// into inheriting a lock pointer at insert time.
		const node = await read_lock_node(t, folder._yay.nodeId);
		expect(node?.readOnlyScopeNodeId).toBeUndefined();
	});
});

/** Lock a node through the public mutation. Fail the test when the mutation refuses. */
async function set_read_only_or_throw(
	asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>,
	membershipId: Id<"organizations_workspaces_users">,
	nodeId: Id<"files_nodes">,
) {
	const locked = await asUser.mutation(api.files_nodes.set_node_read_only, { membershipId, nodeId });
	if (locked._nay) {
		throw new Error(locked._nay.message);
	}
}

/** Unlock a node through the public mutation. Fail the test when the mutation refuses. */
async function set_writable_or_throw(
	asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>,
	membershipId: Id<"organizations_workspaces_users">,
	nodeId: Id<"files_nodes">,
) {
	const unlocked = await asUser.mutation(api.files_nodes.set_node_writable, { membershipId, nodeId });
	if (unlocked._nay) {
		throw new Error(unlocked._nay.message);
	}
}

/** The active child with this name under the parent, or null when none exists. */
function read_active_child(
	t: ReturnType<typeof test_convex>,
	db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
	parentId: Id<"files_nodes"> | typeof files_ROOT_ID,
	name: string,
) {
	return t.run(async (ctx) =>
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("parentId", parentId)
					.eq("name", name)
					.eq("archiveOperationId", undefined),
			)
			.first(),
	);
}

describe("files_nodes.create_folder_node read-only gates", () => {
	test("creating inside a locked folder is refused, writes nothing, and succeeds after unlock", async () => {
		const t = test_convex();
		const { db, asUser, innerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, innerId);

		// The caller is the organization owner: locks bind owners too (RO-03).
		const refused = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: innerId,
			path: "blocked",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		expect(await read_active_child(t, db, innerId, "blocked")).toBeNull();

		await set_writable_or_throw(asUser, db.membershipId, innerId);
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: innerId,
			path: "blocked",
		});
		expect(created._nay).toBeUndefined();
		expect(await read_active_child(t, db, innerId, "blocked")).not.toBeNull();
	});

	test("an unlocked folder with a locked descendant still accepts a new sibling", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, innerId);

		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: outerId,
			path: "fresh-sib",
		});
		expect(created._nay).toBeUndefined();
		expect(await read_active_child(t, db, outerId, "fresh-sib")).not.toBeNull();
	});

	test("a nested path through a locked segment is refused before any intermediate folder exists", async () => {
		const t = test_convex();
		const { db, asUser, innerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, innerId);

		// The path crosses unlocked `/outer`, then stops at read-only `/outer/inner`.
		const refusedThroughSegment = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "outer/inner/deep2",
		});
		expect(refusedThroughSegment._nay?.name).toBe("read_only");
		expect(await read_active_child(t, db, innerId, "deep2")).toBeNull();

		// A missing chain directly under the locked parent is refused before the first insert, so no
		// partial "a" folder is committed.
		const refusedMissingChain = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: innerId,
			path: "a/b",
		});
		expect(refusedMissingChain._nay?.name).toBe("read_only");
		expect(await read_active_child(t, db, innerId, "a")).toBeNull();
	});

	test("the internal mkdir door refuses a locked path segment", async () => {
		const t = test_convex();
		const { db, asUser, innerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, innerId);

		const refused = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/outer/inner/made-by-agent",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await read_active_child(t, db, innerId, "made-by-agent")).toBeNull();
	});
});

describe("files_nodes destination conflict privacy", () => {
	test("rename and move authorize a restricted destination occupant before reporting its conflict", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const fixture = await t.run(async (ctx) => {
			const now = Date.now();
			const memberUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_destination_conflict_member",
			});
			const memberMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: memberUserId,
				active: true,
				updatedAt: now,
			});
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: memberUserId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});

			const commonFile = {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				kind: "file" as const,
				lowercaseExtension: "md",
				contentType: "text/markdown;charset=utf-8",
				updatedAt: now,
			};
			const renameSourceId = await ctx.db.insert("files_nodes", {
				...commonFile,
				parentId: files_ROOT_ID,
				name: "rename-source.md",
				path: "/rename-source.md",
				treePath: "/rename-source.md",
				pathDepth: 1,
			});
			const renameConflictId = await ctx.db.insert("files_nodes", {
				...commonFile,
				parentId: files_ROOT_ID,
				name: "rename-hidden.md",
				path: "/rename-hidden.md",
				treePath: "/rename-hidden.md",
				pathDepth: 1,
			});
			const moveTargetId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "move-target",
				kind: "folder",
				path: "/move-target",
				treePath: "/move-target/",
				pathDepth: 1,
				lowercaseExtension: null,
				updatedAt: now,
			});
			const moveSourceId = await ctx.db.insert("files_nodes", {
				...commonFile,
				parentId: files_ROOT_ID,
				name: "move-source.md",
				path: "/move-source.md",
				treePath: "/move-source.md",
				pathDepth: 1,
			});
			const moveConflictId = await ctx.db.insert("files_nodes", {
				...commonFile,
				parentId: moveTargetId,
				name: "move-source.md",
				path: "/move-target/move-source.md",
				treePath: "/move-target/move-source.md",
				pathDepth: 2,
			});
			await ctx.db.patch("files_nodes", renameConflictId, { restrictedScopeNodeId: renameConflictId });
			await ctx.db.patch("files_nodes", moveConflictId, { restrictedScopeNodeId: moveConflictId });

			return {
				memberUserId,
				memberMembershipId,
				renameSourceId,
				renameConflictId,
				moveTargetId,
				moveSourceId,
				moveConflictId,
			};
		});
		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.memberUserId,
			name: "Destination Conflict Member",
		});

		const hiddenRename = await asMember.mutation(api.files_nodes.rename_node, {
			membershipId: fixture.memberMembershipId,
			nodeId: fixture.renameSourceId,
			path: "rename-hidden.md",
		});
		expect(hiddenRename._nay).toMatchObject({ name: "nay", message: "Permission denied" });

		const hiddenMove = await asMember.mutation(api.files_nodes.move_nodes, {
			membershipId: fixture.memberMembershipId,
			itemIds: [fixture.moveSourceId],
			targetParentId: fixture.moveTargetId,
		});
		expect(hiddenMove._nay).toMatchObject({ name: "nay", message: "Permission denied" });
		expect(await read_lock_node(t, fixture.renameSourceId)).toMatchObject({ path: "/rename-source.md" });
		expect(await read_lock_node(t, fixture.moveSourceId)).toMatchObject({
			parentId: files_ROOT_ID,
			path: "/move-source.md",
		});

		// Once both conflicting nodes are visible, rename and move return the normal path conflict.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", fixture.renameConflictId, { restrictedScopeNodeId: undefined });
			await ctx.db.patch("files_nodes", fixture.moveConflictId, { restrictedScopeNodeId: undefined });
		});
		const visibleRename = await asMember.mutation(api.files_nodes.rename_node, {
			membershipId: fixture.memberMembershipId,
			nodeId: fixture.renameSourceId,
			path: "rename-hidden.md",
		});
		expect(visibleRename._nay).toMatchObject({ name: "nay", message: "Path already exists" });

		const visibleMove = await asMember.mutation(api.files_nodes.move_nodes, {
			membershipId: fixture.memberMembershipId,
			itemIds: [fixture.moveSourceId],
			targetParentId: fixture.moveTargetId,
		});
		expect(visibleMove._nay).toMatchObject({ name: "nay", message: "Path already exists" });
	});
});

describe("files_nodes.rename_node read-only gates", () => {
	test("a locked node cannot be renamed and renames after unlock (owner gets no bypass)", async () => {
		const t = test_convex();
		const { db, asUser, innerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, innerId);

		const refused = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			nodeId: innerId,
			path: "inner2",
		});
		expect(refused._nay?.name).toBe("read_only");
		const innerAfterRefusal = await read_lock_node(t, innerId);
		expect(innerAfterRefusal?.name).toBe("inner");
		expect(innerAfterRefusal?.path).toBe("/outer/inner");

		await set_writable_or_throw(asUser, db.membershipId, innerId);
		const renamed = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			nodeId: innerId,
			path: "inner2",
		});
		expect(renamed._nay).toBeUndefined();
		expect((await read_lock_node(t, innerId))?.path).toBe("/outer/inner2");
	});

	test("an inherited lock refuses the rename too", async () => {
		const t = test_convex();
		const { db, asUser, outerId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, outerId);

		const refused = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			nodeId: siblingId,
			path: "sibling2",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, siblingId))?.path).toBe("/outer/sibling");
	});

	test("a locked descendant blocks renaming its ancestor folder", async () => {
		const t = test_convex();
		const { db, asUser, outerId, deepId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, deepId);

		const refused = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			nodeId: outerId,
			path: "outer2",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, outerId))?.path).toBe("/outer");
		expect((await read_lock_node(t, deepId))?.path).toBe("/outer/inner/deep");

		// A folder whose subtree holds no lock still renames while the sibling lock exists.
		const renamedSibling = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			nodeId: siblingId,
			path: "sibling2",
		});
		expect(renamedSibling._nay).toBeUndefined();
		expect((await read_lock_node(t, siblingId))?.path).toBe("/outer/sibling2");
	});

	test("a locked archived descendant also blocks renaming the folder", async () => {
		const t = test_convex();
		const { db, asUser, outerId, frozenId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, frozenId);

		const refused = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			nodeId: outerId,
			path: "outer3",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, outerId))?.path).toBe("/outer");
		const frozen = await read_lock_node(t, frozenId);
		expect(frozen?.path).toBe("/outer/frozen");
		expect(frozen?.archiveOperationId).toBeDefined();
	});

	test("a locked archived tree with the same path does not block renaming the new active tree", async () => {
		const t = test_convex();
		const { db, asUser, archivedChildId, activeRootId, activeChildId } =
			await seed_reused_read_only_path_tree(t);

		const renamed = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			nodeId: activeRootId,
			path: "docs-renamed",
		});
		expect(renamed._nay).toBeUndefined();
		expect((await read_lock_node(t, activeRootId))?.path).toBe("/docs-renamed");
		expect((await read_lock_node(t, activeChildId))?.path).toBe("/docs-renamed/current");
		expect((await read_lock_node(t, archivedChildId))?.path).toBe("/docs/secret");
	});

	test("renaming into a locked destination folder is refused", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, innerId);

		const refused = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			nodeId: siblingId,
			path: "inner/sibling",
		});
		expect(refused._nay?.name).toBe("read_only");
		const sibling = await read_lock_node(t, siblingId);
		expect(sibling?.parentId).toBe(outerId);
		expect(sibling?.path).toBe("/outer/sibling");
	});

	test("a refused rename leaves no partially created intermediate folder", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, deepId);

		// The path needs a new `made` folder under `/outer`.
		// Check the locked descendant before creating that folder.
		const refused = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			nodeId: innerId,
			path: "made/inner2",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await read_active_child(t, db, outerId, "made")).toBeNull();
		expect((await read_lock_node(t, innerId))?.path).toBe("/outer/inner");
	});
});

describe("files_nodes.move_nodes read-only gates", () => {
	test("one locked node in the batch refuses the whole move and nothing moves", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, siblingId);

		const refused = await asUser.mutation(api.files_nodes.move_nodes, {
			membershipId: db.membershipId,
			itemIds: [deepId, siblingId],
			targetParentId: files_ROOT_ID,
		});
		expect(refused._nay?.name).toBe("read_only");
		const deep = await read_lock_node(t, deepId);
		expect(deep?.parentId).toBe(innerId);
		expect(deep?.path).toBe("/outer/inner/deep");
		const sibling = await read_lock_node(t, siblingId);
		expect(sibling?.parentId).toBe(outerId);
		expect(sibling?.path).toBe("/outer/sibling");
	});

	test("moving into a locked destination folder is refused", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, innerId);

		const refused = await asUser.mutation(api.files_nodes.move_nodes, {
			membershipId: db.membershipId,
			itemIds: [siblingId],
			targetParentId: innerId,
		});
		expect(refused._nay?.name).toBe("read_only");
		const sibling = await read_lock_node(t, siblingId);
		expect(sibling?.parentId).toBe(outerId);
		expect(sibling?.path).toBe("/outer/sibling");
	});

	test("a locked descendant blocks moving its ancestor folder", async () => {
		const t = test_convex();
		const { db, asUser, deepId, innerId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, deepId);

		const refused = await asUser.mutation(api.files_nodes.move_nodes, {
			membershipId: db.membershipId,
			itemIds: [innerId],
			targetParentId: files_ROOT_ID,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, innerId))?.path).toBe("/outer/inner");
		expect((await read_lock_node(t, deepId))?.path).toBe("/outer/inner/deep");

		// A folder with no locked subtree member still moves while the other lock exists.
		const movedSibling = await asUser.mutation(api.files_nodes.move_nodes, {
			membershipId: db.membershipId,
			itemIds: [siblingId],
			targetParentId: files_ROOT_ID,
		});
		expect(movedSibling._nay).toBeUndefined();
		expect((await read_lock_node(t, siblingId))?.path).toBe("/sibling");
	});

	test("a locked archived descendant blocks moving the folder", async () => {
		const t = test_convex();
		const { db, asUser, innerId, deepId } = await seed_read_only_lock_tree(t);

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [deepId],
		});
		expect(archived._nay).toBeUndefined();
		await set_read_only_or_throw(asUser, db.membershipId, deepId);

		const refused = await asUser.mutation(api.files_nodes.move_nodes, {
			membershipId: db.membershipId,
			itemIds: [innerId],
			targetParentId: files_ROOT_ID,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, innerId))?.path).toBe("/outer/inner");
		const deep = await read_lock_node(t, deepId);
		expect(deep?.path).toBe("/outer/inner/deep");
		expect(deep?.archiveOperationId).toBeDefined();
	});

	test("a locked archived tree with the same path does not block moving the new active tree", async () => {
		const t = test_convex();
		const { db, asUser, archivedChildId, activeRootId, activeChildId, targetId } =
			await seed_reused_read_only_path_tree(t);

		const moved = await asUser.mutation(api.files_nodes.move_nodes, {
			membershipId: db.membershipId,
			itemIds: [activeRootId],
			targetParentId: targetId,
		});
		expect(moved._nay).toBeUndefined();
		expect((await read_lock_node(t, activeRootId))?.path).toBe("/target/docs");
		expect((await read_lock_node(t, activeChildId))?.path).toBe("/target/docs/current");
		expect((await read_lock_node(t, archivedChildId))?.path).toBe("/docs/secret");
	});
});

describe("files_nodes.archive_nodes read-only gates", () => {
	test("archiving a locked node is refused and archives after unlock", async () => {
		const t = test_convex();
		const { db, asUser, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, siblingId);

		const refused = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [siblingId],
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, siblingId))?.archiveOperationId).toBeUndefined();

		await set_writable_or_throw(asUser, db.membershipId, siblingId);
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [siblingId],
		});
		expect(archived._nay).toBeUndefined();
		expect((await read_lock_node(t, siblingId))?.archiveOperationId).toBeDefined();
	});

	test("a locked active descendant blocks archiving the folder", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, deepId);

		const refused = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [outerId],
		});
		expect(refused._nay?.name).toBe("read_only");
		for (const nodeId of [outerId, innerId, deepId, siblingId]) {
			expect((await read_lock_node(t, nodeId))?.archiveOperationId).toBeUndefined();
		}
	});

	test("a locked archived tree with the same path does not block archiving the new active tree", async () => {
		const t = test_convex();
		const { db, asUser, archivedRootId, archivedChildId, activeRootId, activeChildId } =
			await seed_reused_read_only_path_tree(t);
		const archivedRootBefore = await read_lock_node(t, archivedRootId);
		const archivedChildBefore = await read_lock_node(t, archivedChildId);

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [activeRootId],
		});
		expect(archived._nay).toBeUndefined();
		const activeRoot = await read_lock_node(t, activeRootId);
		const activeChild = await read_lock_node(t, activeChildId);
		expect(activeRoot?.archiveOperationId).toBeDefined();
		expect(activeChild?.archiveOperationId).toBe(activeRoot?.archiveOperationId);
		expect((await read_lock_node(t, archivedRootId))?.archiveOperationId).toBe(
			archivedRootBefore?.archiveOperationId,
		);
		expect((await read_lock_node(t, archivedChildId))?.archiveOperationId).toBe(
			archivedChildBefore?.archiveOperationId,
		);
	});

	test("archived descendants: hidden unlocked ignored, visible locked refused, hidden locked stays hidden", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Owner",
		});

		// Three parents, each with one archived child in a different lock/visibility state.
		const parentIds: Array<Id<"files_nodes">> = [];
		const childIds: Array<Id<"files_nodes">> = [];
		for (const index of [1, 2, 3]) {
			const parent = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				path: `arch${index}`,
			});
			if (parent._nay) {
				throw new Error(parent._nay.message);
			}
			const child = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: parent._yay.nodeId,
				path: `c${index}`,
			});
			if (child._nay) {
				throw new Error(child._nay.message);
			}
			parentIds.push(parent._yay.nodeId);
			childIds.push(child._yay.nodeId);
		}
		const [arch1Id, arch2Id, arch3Id] = parentIds;
		const [c1Id, c2Id, c3Id] = childIds;
		if (!arch1Id || !arch2Id || !arch3Id || !c1Id || !c2Id || !c3Id) {
			throw new Error("Expected three parents and three children");
		}

		const archivedChildren = await asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [c1Id, c2Id, c3Id],
		});
		expect(archivedChildren._nay).toBeUndefined();
		await set_read_only_or_throw(asOwner, db.membershipId, c2Id);
		await set_read_only_or_throw(asOwner, db.membershipId, c3Id);

		// Restrict c1 and c3 so a plain member cannot read them. The member has no grant on these
		// scopes, so both children are hidden to them.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", c1Id, { restrictedScopeNodeId: c1Id });
			await ctx.db.patch("files_nodes", c3Id, { restrictedScopeNodeId: c3Id });
		});

		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_read_only_archived_member",
			});
			const now = Date.now();
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: otherUserId,
				active: true,
				updatedAt: now,
			});
			// Archiving needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});
			return { otherUserId, otherMembershipId };
		});
		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Read Only Member",
		});

		// Hidden but unlocked: the archive call will not write the archived child, so it is ignored
		// and the ordinary ACL scope does not widen.
		const c1Before = await read_lock_node(t, c1Id);
		const archivedArch1 = await asMember.mutation(api.files_nodes.archive_nodes, {
			membershipId: other.otherMembershipId,
			nodeIds: [arch1Id],
		});
		expect(archivedArch1._nay).toBeUndefined();
		expect((await read_lock_node(t, arch1Id))?.archiveOperationId).toBeDefined();
		expect((await read_lock_node(t, c1Id))?.archiveOperationId).toBe(c1Before?.archiveOperationId);

		// Visible and locked: the precise read-only refusal, and no write happened.
		const refusedVisible = await asMember.mutation(api.files_nodes.archive_nodes, {
			membershipId: other.otherMembershipId,
			nodeIds: [arch2Id],
		});
		expect(refusedVisible._nay?.name).toBe("read_only");
		expect(refusedVisible._nay?.message).toBe("This item is read-only.");
		expect((await read_lock_node(t, arch2Id))?.archiveOperationId).toBeUndefined();

		// Hidden and locked: the same generic denial hidden restricted content uses, never naming
		// the node (RO-10).
		const refusedHidden = await asMember.mutation(api.files_nodes.archive_nodes, {
			membershipId: other.otherMembershipId,
			nodeIds: [arch3Id],
		});
		expect(refusedHidden._nay?.message).toBe("Permission denied");
		expect(refusedHidden._nay?.name).not.toBe("read_only");
		expect((await read_lock_node(t, arch3Id))?.archiveOperationId).toBeUndefined();
	});
});

describe("files_nodes.unarchive_nodes read-only gates", () => {
	test("restoring one archived lineage ignores a locked archived tree that reused its path", async () => {
		const t = test_convex();
		const { db, asUser, archivedRootId, archivedChildId, activeRootId, activeChildId } =
			await seed_reused_read_only_path_tree(t);

		const archivedSecondTree = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [activeRootId],
		});
		expect(archivedSecondTree._nay).toBeUndefined();
		const secondArchiveOperationId = (await read_lock_node(t, activeRootId))?.archiveOperationId;
		expect(secondArchiveOperationId).toBeDefined();

		const restoredSecondTree = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [activeRootId],
		});
		expect(restoredSecondTree._nay).toBeUndefined();
		expect((await read_lock_node(t, activeRootId))?.archiveOperationId).toBeUndefined();
		expect((await read_lock_node(t, activeChildId))?.archiveOperationId).toBeUndefined();

		// The first archived `/docs` tree has different parent ids.
		// Its lock does not block this restore, and none of its nodes are restored.
		const firstRoot = await read_lock_node(t, archivedRootId);
		const firstChild = await read_lock_node(t, archivedChildId);
		expect(firstRoot?.archiveOperationId).toBeDefined();
		expect(firstChild?.archiveOperationId).toBeDefined();
		expect(firstChild?.readOnlyScopeNodeId).toBe(archivedChildId);
	});

	test("a locked node anywhere in the restored subtree blocks the restore until unlock", async () => {
		const t = test_convex();
		const { db, asUser, innerId, deepId } = await seed_read_only_lock_tree(t);

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [innerId],
		});
		expect(archived._nay).toBeUndefined();
		const innerArchivedOperationId = (await read_lock_node(t, innerId))?.archiveOperationId;
		expect(innerArchivedOperationId).toBeDefined();

		// A locked archived descendant blocks restoring its ancestor.
		await set_read_only_or_throw(asUser, db.membershipId, deepId);
		const refusedByDescendant = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [innerId],
		});
		expect(refusedByDescendant._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, innerId))?.archiveOperationId).toBe(innerArchivedOperationId);
		expect((await read_lock_node(t, deepId))?.archiveOperationId).toBe(innerArchivedOperationId);

		// The named node's own lock blocks too.
		await set_writable_or_throw(asUser, db.membershipId, deepId);
		await set_read_only_or_throw(asUser, db.membershipId, innerId);
		const refusedByNamedNode = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [innerId],
		});
		expect(refusedByNamedNode._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, innerId))?.archiveOperationId).toBe(innerArchivedOperationId);

		await set_writable_or_throw(asUser, db.membershipId, innerId);
		const restored = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [innerId],
		});
		expect(restored._nay).toBeUndefined();
		const inner = await read_lock_node(t, innerId);
		expect(inner?.archiveOperationId).toBeUndefined();
		expect(inner?.path).toBe("/outer/inner");
		const deep = await read_lock_node(t, deepId);
		expect(deep?.archiveOperationId).toBeUndefined();
		expect(deep?.path).toBe("/outer/inner/deep");
	});
});

/**
 * A file node with one stored snapshot for the snapshot archive-state gates. `archivedAt` seeds the
 * snapshot's starting state. Each caller gets a fresh convex-test instance because the
 * `files_snapshot_write` bucket only allows two writes per window, and every gate test spends both.
 */
async function seed_read_only_snapshot(t: ReturnType<typeof test_convex>, archivedAt: number) {
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Read Only Snapshot User",
	});
	const snapshotId = await t.run(async (ctx) => {
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/read-only-snapshot`,
			size: 0,
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		return await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: db.files.file_root_1._id,
			assetId,
			createdBy: db.userId,
			archivedAt,
		});
	});

	return { db, asUser, snapshotId, fileNodeId: db.files.file_root_1._id };
}

describe("files_nodes.archive_snapshot and unarchive_snapshot read-only gates", () => {
	test("archiving a snapshot of a locked file is refused while browsing stays allowed", async () => {
		const t = test_convex();
		const { db, asUser, snapshotId, fileNodeId } = await seed_read_only_snapshot(t, 0);

		await set_read_only_or_throw(asUser, db.membershipId, fileNodeId);
		const refused = await asUser.mutation(api.files_nodes.archive_snapshot, {
			membershipId: db.membershipId,
			snapshotId,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await t.run(async (ctx) => ctx.db.get("files_snapshots", snapshotId)))?.archivedAt).toBe(0);

		// Browsing the version list stays allowed on a read-only file.
		const listed = await asUser.query(api.files_nodes.get_file_snapshots_list, {
			membershipId: db.membershipId,
			nodeId: fileNodeId,
			showArchived: false,
		});
		expect(listed.snapshots).toHaveLength(1);

		await set_writable_or_throw(asUser, db.membershipId, fileNodeId);
		const archivedSnapshot = await asUser.mutation(api.files_nodes.archive_snapshot, {
			membershipId: db.membershipId,
			snapshotId,
		});
		expect(archivedSnapshot._nay).toBeUndefined();
		expect((await t.run(async (ctx) => ctx.db.get("files_snapshots", snapshotId)))?.archivedAt).toBeGreaterThan(0);
	});

	test("restoring a snapshot of a locked file is refused and succeeds after unlock", async () => {
		const t = test_convex();
		const seededArchivedAt = Date.now();
		const { db, asUser, snapshotId, fileNodeId } = await seed_read_only_snapshot(t, seededArchivedAt);

		await set_read_only_or_throw(asUser, db.membershipId, fileNodeId);
		const refused = await asUser.mutation(api.files_nodes.unarchive_snapshot, {
			membershipId: db.membershipId,
			snapshotId,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await t.run(async (ctx) => ctx.db.get("files_snapshots", snapshotId)))?.archivedAt).toBe(seededArchivedAt);

		await set_writable_or_throw(asUser, db.membershipId, fileNodeId);
		const restoredSnapshot = await asUser.mutation(api.files_nodes.unarchive_snapshot, {
			membershipId: db.membershipId,
			snapshotId,
		});
		expect(restoredSnapshot._nay).toBeUndefined();
		expect((await t.run(async (ctx) => ctx.db.get("files_snapshots", snapshotId)))?.archivedAt).toBe(0);
	});
});

describe("files_nodes.yjs_push_update read-only gates", () => {
	async function seed_yjs_push_file(t: ReturnType<typeof test_convex>, path: string) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Yjs User",
		});
		const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path,
		});
		if (createdFile._nay) {
			throw new Error(createdFile._nay.message);
		}
		return { db, asUser, nodeId: createdFile._yay.nodeId };
	}

	/** The file's Yjs write state: stored update docs and the reserved sequence counter. */
	function read_yjs_write_state(
		t: ReturnType<typeof test_convex>,
		db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
		nodeId: Id<"files_nodes">,
	) {
		return t.run(async (ctx) => {
			const updates = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			const lastSequence = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			return { updateCount: updates.length, lastSequence: lastSequence?.lastSequence ?? null };
		});
	}

	test("a direct lock refuses the push before any sequence reserve and unlock lets it through", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_yjs_push_file(t, "read-only-push-direct.md");
		await set_read_only_or_throw(asUser, db.membershipId, nodeId);

		const before = await read_yjs_write_state(t, db, nodeId);
		// The current lock refuses the write.
		const refused = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
			sessionId: "read-only-push-direct",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		// The refusal reserved no sequence and stored no update doc.
		expect(await read_yjs_write_state(t, db, nodeId)).toEqual(before);

		await set_writable_or_throw(asUser, db.membershipId, nodeId);
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
			sessionId: "read-only-push-direct",
		});
		if (pushed._nay) {
			throw new Error(pushed._nay.message);
		}
		expect(pushed._yay.newSequence).toBe(1);
	});

	test("an inherited lock from a parent folder refuses the push", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Yjs User",
		});
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "locked-folder",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: folder._yay.nodeId,
			path: "inside.md",
		});
		if (createdFile._nay) {
			throw new Error(createdFile._nay.message);
		}
		await set_read_only_or_throw(asUser, db.membershipId, folder._yay.nodeId);

		const before = await read_yjs_write_state(t, db, createdFile._yay.nodeId);
		const refused = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId: createdFile._yay.nodeId,
			update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
			sessionId: "read-only-push-inherited",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await read_yjs_write_state(t, db, createdFile._yay.nodeId)).toEqual(before);
	});

	test("a push succeeds after a lock is removed", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_yjs_push_file(t, "read-only-push-stale.md");
		await set_read_only_or_throw(asUser, db.membershipId, nodeId);
		await set_writable_or_throw(asUser, db.membershipId, nodeId);

		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
			sessionId: "read-only-push-stale",
		});
		if (pushed._nay) {
			throw new Error(pushed._nay.message);
		}
		expect(pushed._yay.newSequence).toBe(1);
	});
});

/** Every unfinalized upload asset doc in the workspace. */
function read_upload_assets(
	t: ReturnType<typeof test_convex>,
	db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	return t.run(async (ctx) =>
		ctx.db
			.query("files_r2_assets")
			.collect()
			.then((assets) =>
				assets.filter(
					(asset) =>
						asset.organizationId === db.organizationId &&
						asset.workspaceId === db.workspaceId &&
						asset.kind === "upload",
				),
			),
	);
}

describe("files_nodes.create_upload_node read-only gates", () => {
	test("refuses a locked destination folder before any asset or node write", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, outerId);

		const refused = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: outerId,
			filename: "report.pdf",
			contentType: "application/pdf",
			size: 10,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		expect(await read_active_child(t, db, outerId, "report.pdf")).toBeNull();
		expect(await read_upload_assets(t, db)).toHaveLength(0);

		await set_writable_or_throw(asUser, db.membershipId, outerId);
		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: outerId,
			filename: "report.pdf",
			contentType: "application/pdf",
			size: 10,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		// The accepted upload stores its temporary R2 key and the upload URL expiry time.
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(asset?.uploadStagingR2Key).toContain(`/upload-staging/${upload._yay.assetId}`);
		expect(asset?.uploadUrlExpiresAt).toEqual(expect.any(Number));
	});

	test("refuses a filename that walks through a locked existing folder", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, outerId);

		const refused = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "outer/nested.pdf",
			contentType: "application/pdf",
			size: 10,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await read_upload_assets(t, db)).toHaveLength(0);
	});

	test("refuses replacing a locked occupant and leaves it active", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Upload User",
		});

		const first = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "taken.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		await set_read_only_or_throw(asUser, db.membershipId, first._yay.nodeId);

		const refused = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "taken.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		expect(refused._nay?.name).toBe("read_only");
		// The locked occupant kept its path and no second asset doc was written.
		const occupant = await t.run(async (ctx) => ctx.db.get("files_nodes", first._yay.nodeId));
		expect(occupant?.archiveOperationId).toBeUndefined();
		expect(await read_upload_assets(t, db)).toHaveLength(1);

		await set_writable_or_throw(asUser, db.membershipId, first._yay.nodeId);
		const replaced = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "taken.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		if (replaced._nay) {
			throw new Error(replaced._nay.message);
		}
		const docs = await t.run(async (ctx) => ({
			oldNode: await ctx.db.get("files_nodes", first._yay.nodeId),
			newAsset: await ctx.db.get("files_r2_assets", replaced._yay.assetId),
		}));
		expect(docs.oldNode?.archiveOperationId).toBeDefined();
		expect(docs.newAsset?.uploadStagingR2Key).toContain(`/upload-staging/${replaced._yay.assetId}`);
	});
});

describe("files_nodes.create_upload_nodes read-only gates", () => {
	test("a locked common destination refuses the whole call before any write", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw(asUser, db.membershipId, outerId);

		const refused = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: outerId,
			onConflict: "skip",
			items: [
				{ relativePath: "a.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "b.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		expect(await read_upload_assets(t, db)).toHaveLength(0);
	});

	test("locked occupants and locked folders skip their items without archiving while others import", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);

		const occupant = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "taken.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		if (occupant._nay) {
			throw new Error(occupant._nay.message);
		}
		await set_read_only_or_throw(asUser, db.membershipId, occupant._yay.nodeId);
		await set_read_only_or_throw(asUser, db.membershipId, outerId);

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "replace",
			items: [
				{ relativePath: "taken.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "outer/blocked.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "fresh.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}
		// Locked items report the same generic conflict as restricted ones, and only they skip.
		expect(imported._yay.skipped).toEqual([
			{ relativePath: "taken.pdf", reason: "conflict" },
			{ relativePath: "outer/blocked.pdf", reason: "conflict" },
		]);
		expect(imported._yay.created).toHaveLength(1);
		expect(imported._yay.created[0]).toMatchObject({ relativePath: "fresh.pdf" });

		const docs = await t.run(async (ctx) => ({
			occupantNode: await ctx.db.get("files_nodes", occupant._yay.nodeId),
			freshAsset: await ctx.db.get("files_r2_assets", imported._yay.created[0]!.assetId),
		}));
		// The locked occupant was skipped, not archived.
		expect(docs.occupantNode?.archiveOperationId).toBeUndefined();
		expect(docs.freshAsset?.uploadStagingR2Key).toContain(`/upload-staging/${imported._yay.created[0]!.assetId}`);
		expect(docs.freshAsset?.uploadUrlExpiresAt).toEqual(expect.any(Number));
	});
});

describe("files_nodes.discard_failed_upload_node read-only gates", () => {
	test("a direct lock keeps the failed placeholder and unlock lets the creator discard it", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Discard User",
		});
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "failed.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await set_read_only_or_throw(asUser, db.membershipId, upload._yay.nodeId);

		const refused = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId: upload._yay.nodeId,
		});
		expect(refused._nay?.name).toBe("read_only");
		const kept = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", upload._yay.nodeId),
			asset: await ctx.db.get("files_r2_assets", upload._yay.assetId),
		}));
		expect(kept.node).not.toBeNull();
		expect(kept.asset).not.toBeNull();

		await set_writable_or_throw(asUser, db.membershipId, upload._yay.nodeId);
		const discarded = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId: upload._yay.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		expect(discarded._yay.removed).toBe(true);
	});

	test("an inherited lock keeps the failed placeholder", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Discard User",
		});

		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "uploads",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: folder._yay.nodeId,
			filename: "refused.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await set_read_only_or_throw(asUser, db.membershipId, folder._yay.nodeId);
		const refused = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId: upload._yay.nodeId,
		});
		expect(refused._nay?.name).toBe("read_only");
		// Discard deletes the node, so the inherited lock keeps both docs in place.
		const kept = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", upload._yay.nodeId),
			asset: await ctx.db.get("files_r2_assets", upload._yay.assetId),
		}));
		expect(kept.node).not.toBeNull();
		expect(kept.asset).not.toBeNull();
	});
});

describe("files_nodes.remove_eager_created_node_if_safe read-only gates", () => {
	async function seed_eager_branch(t: ReturnType<typeof test_convex>, path: string) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Eager User",
		});
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		if (!created._yay.created || created._yay.createdCommittedSequence === undefined) {
			throw new Error("Expected create_file_by_path to create a fresh node");
		}
		return {
			db,
			asUser,
			nodeId: created._yay.nodeId,
			eagerCreatedCommittedSequence: created._yay.createdCommittedSequence,
			createdAncestorIds: created._yay.createdAncestorIds,
		};
	}

	test("a lock after the eager create keeps the leaf and its created ancestors", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, asUser, nodeId, eagerCreatedCommittedSequence, createdAncestorIds } =
			await seed_eager_branch(t, "/ro-eager/deep/x.md");
		// Ancestors come deepest-first, so the last one is the shallow /ro-eager folder. Locking
		// it cascades over the whole created branch.
		const shallowAncestorId = createdAncestorIds[createdAncestorIds.length - 1];
		if (!shallowAncestorId) {
			throw new Error("Expected created ancestor folder ids");
		}
		await set_read_only_or_throw(asUser, db.membershipId, shallowAncestorId);

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
			createdAncestorIds,
		});
		expect(removed._yay).toEqual({ removed: false, ancestorsLeft: 2 });

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).not.toBeNull();
			for (const ancestorId of createdAncestorIds) {
				expect(await ctx.db.get("files_nodes", ancestorId)).not.toBeNull();
			}
		});
	});

	test("a lock then unlock lets cleanup remove the writable branch", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, asUser, nodeId, eagerCreatedCommittedSequence, createdAncestorIds } =
			await seed_eager_branch(t, "/ro-eager-cycle/deep/x.md");
		const shallowAncestorId = createdAncestorIds[createdAncestorIds.length - 1];
		if (!shallowAncestorId) {
			throw new Error("Expected created ancestor folder ids");
		}
		await set_read_only_or_throw(asUser, db.membershipId, shallowAncestorId);
		await set_writable_or_throw(asUser, db.membershipId, shallowAncestorId);

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
			createdAncestorIds,
		});
		expect(removed._yay).toEqual({ removed: true, ancestorsLeft: 0 });

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).toBeNull();
			for (const ancestorId of createdAncestorIds) {
				expect(await ctx.db.get("files_nodes", ancestorId)).toBeNull();
			}
		});
	});

	test("an unchanged writable branch is removed", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const { db, nodeId, eagerCreatedCommittedSequence, createdAncestorIds } = await seed_eager_branch(
			t,
			"/ro-eager-control/deep/x.md",
		);

		const removed = await t.mutation(internal.files_nodes.remove_eager_created_node_if_safe, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			eagerCreatedCommittedSequence,
			createdAncestorIds,
		});
		expect(removed._yay).toEqual({ removed: true, ancestorsLeft: 0 });

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", nodeId)).toBeNull();
			for (const ancestorId of createdAncestorIds) {
				expect(await ctx.db.get("files_nodes", ancestorId)).toBeNull();
			}
		});
	});
});

describe("files_nodes_db_apply_pending_move read-only gates", () => {
	async function seed_apply_move_file(t: ReturnType<typeof test_convex>, path: string) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Apply Move User",
		});
		const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path,
		});
		if (createdFile._nay) {
			throw new Error(createdFile._nay.message);
		}
		return { db, asUser, nodeId: createdFile._yay.nodeId };
	}

	test("a locked source refuses the apply and unlock lets the same move through", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_apply_move_file(t, "pending-src.md");
		await set_read_only_or_throw(asUser, db.membershipId, nodeId);

		const applied = await t.run(async (ctx) =>
			files_nodes_db_apply_pending_move(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				destParentId: files_ROOT_ID,
				destName: "pending-src-moved.md",
				userId: db.userId,
				updatedBy: db.userId,
				authorizeCycleMember: async () => true,
			}),
		);
		expect(applied._nay).toMatchObject({ name: "read_only" });
		expect((await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/pending-src.md");

		await set_writable_or_throw(asUser, db.membershipId, nodeId);
		const appliedAfterUnlock = await t.run(async (ctx) =>
			files_nodes_db_apply_pending_move(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				destParentId: files_ROOT_ID,
				destName: "pending-src-moved.md",
				userId: db.userId,
				updatedBy: db.userId,
				authorizeCycleMember: async () => true,
			}),
		);
		expect(appliedAfterUnlock._nay).toBeUndefined();
		expect((await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/pending-src-moved.md");
	});

	test("a locked destination folder refuses the apply", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_apply_move_file(t, "pending-src-dest.md");
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "pending-dest",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		await set_read_only_or_throw(asUser, db.membershipId, folder._yay.nodeId);

		const applied = await t.run(async (ctx) =>
			files_nodes_db_apply_pending_move(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				destParentId: folder._yay.nodeId,
				destName: "pending-src-dest.md",
				userId: db.userId,
				updatedBy: db.userId,
				authorizeCycleMember: async () => true,
			}),
		);
		expect(applied._nay).toMatchObject({ name: "read_only" });
		expect((await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/pending-src-dest.md");
	});

	test("a locked replacement occupant refuses the apply and stays active", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_apply_move_file(t, "pending-src-replace.md");
		const occupant = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "occupied.md",
		});
		if (occupant._nay) {
			throw new Error(occupant._nay.message);
		}
		await set_read_only_or_throw(asUser, db.membershipId, occupant._yay.nodeId);

		const applied = await t.run(async (ctx) =>
			files_nodes_db_apply_pending_move(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				destParentId: files_ROOT_ID,
				destName: "occupied.md",
				userId: db.userId,
				updatedBy: db.userId,
				authorizeCycleMember: async () => true,
			}),
		);
		expect(applied._nay).toMatchObject({ name: "read_only" });
		const docs = await t.run(async (ctx) => ({
			source: await ctx.db.get("files_nodes", nodeId),
			occupantNode: await ctx.db.get("files_nodes", occupant._yay.nodeId),
		}));
		expect(docs.source?.path).toBe("/pending-src-replace.md");
		expect(docs.occupantNode?.archiveOperationId).toBeUndefined();
	});
});

describe("files_nodes public read-only projection", () => {
	/**
	 * A workspace where a second member holds a grant on the nested restricted folder but has no
	 * workspace-wide read. The outer folder is both unreadable for them and the lock root.
	 */
	async function seed_hidden_lock_root(t: ReturnType<typeof test_convex>) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Projection Owner",
		});

		const outer = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "outer",
		});
		if (outer._nay) {
			throw new Error(outer._nay.message);
		}
		const inner = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: outer._yay.nodeId,
			path: "inner",
		});
		if (inner._nay) {
			throw new Error(inner._nay.message);
		}
		const file = await asOwner.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: inner._yay.nodeId,
			path: "secret.md",
		});
		if (file._nay) {
			throw new Error(file._nay.message);
		}

		// The nested folder becomes a restricted scope and the second member gets a direct grant
		// on it. File sharing does not write these grants yet, so the test inserts the docs.
		const member = await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", inner._yay.nodeId, { restrictedScopeNodeId: inner._yay.nodeId });
			await ctx.db.patch("files_nodes", file._yay.nodeId, { restrictedScopeNodeId: inner._yay.nodeId });

			const memberUserId = await ctx.db.insert("users", { clerkUserId: "clerk_projection_member" });
			const now = Date.now();
			const memberMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: memberUserId,
				active: true,
				updatedAt: now,
			});
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				resourceKind: "file",
				resourceId: String(inner._yay.nodeId),
				principalKind: "user",
				userId: memberUserId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
			return { memberUserId, memberMembershipId };
		});
		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: member.memberUserId,
			name: "Projection Member",
		});

		// Lock the outer folder: the lock root sits above the member's readable scope.
		await set_read_only_or_throw(asOwner, db.membershipId, outer._yay.nodeId);

		return {
			db,
			asOwner,
			asMember,
			memberMembershipId: member.memberMembershipId,
			outerId: outer._yay.nodeId,
			innerId: inner._yay.nodeId,
			fileId: file._yay.nodeId,
		};
	}

	test("list_tree reports inherited state without naming a lock root the member cannot read", async () => {
		const t = test_convex();
		const f = await seed_hidden_lock_root(t);

		const memberTree = await f.asMember.query(api.files_nodes.list_tree, { membershipId: f.memberMembershipId });
		// Only the granted scope is listed; the outer lock root itself never appears.
		expect(memberTree.map((node) => node.path).sort()).toEqual(["/outer/inner", "/outer/inner/secret.md"]);
		for (const node of memberTree) {
			expect(node.readOnlyState).toBe("inherited");
			expect(node.readOnlySourceNodeId).toBeUndefined();
			expect(node.readOnlySourcePath).toBeUndefined();
			// The raw pointer must not leave the backend: it would name the hidden outer folder.
			expect("readOnlyScopeNodeId" in node).toBe(false);
		}

		// The owner can read the lock root, so each returned node may name it.
		const ownerTree = await f.asOwner.query(api.files_nodes.list_tree, { membershipId: f.db.membershipId });
		const outerRow = ownerTree.find((node) => node._id === f.outerId);
		const innerRow = ownerTree.find((node) => node._id === f.innerId);
		expect(outerRow).toMatchObject({
			readOnlyState: "self",
			readOnlySourceNodeId: f.outerId,
			readOnlySourcePath: "/outer",
		});
		expect(innerRow).toMatchObject({
			readOnlyState: "inherited",
			readOnlySourceNodeId: f.outerId,
			readOnlySourcePath: "/outer",
		});
	});

	test("get_file_node_for_membership omits the source for a hidden lock root and names it for the owner", async () => {
		const t = test_convex();
		const f = await seed_hidden_lock_root(t);

		const memberView = await f.asMember.query(api.files_nodes.get_file_node_for_membership, {
			membershipId: f.memberMembershipId,
			fileNodeId: f.fileId,
		});
		expect(memberView).toMatchObject({ readOnlyState: "inherited" });
		expect(memberView?.readOnlySourceNodeId).toBeUndefined();
		expect(memberView?.readOnlySourcePath).toBeUndefined();
		expect(memberView !== null && "readOnlyScopeNodeId" in memberView).toBe(false);

		const ownerView = await f.asOwner.query(api.files_nodes.get_file_node_for_membership, {
			membershipId: f.db.membershipId,
			fileNodeId: f.fileId,
		});
		expect(ownerView).toMatchObject({
			readOnlyState: "inherited",
			readOnlySourceNodeId: f.outerId,
			readOnlySourcePath: "/outer",
		});

		// A self-locked node names itself as the source.
		const outerView = await f.asOwner.query(api.files_nodes.get_file_node_for_membership, {
			membershipId: f.db.membershipId,
			fileNodeId: f.outerId,
		});
		expect(outerView).toMatchObject({
			readOnlyState: "self",
			readOnlySourceNodeId: f.outerId,
			readOnlySourcePath: "/outer",
		});
	});

	test("a writable node projects writable state with no source", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Projection Writable User",
		});
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "plain",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		const view = await asUser.query(api.files_nodes.get_file_node_for_membership, {
			membershipId: db.membershipId,
			fileNodeId: folder._yay.nodeId,
		});
		expect(view).toMatchObject({ readOnlyState: "writable" });
		expect(view?.readOnlySourceNodeId).toBeUndefined();
		expect(view?.readOnlySourcePath).toBeUndefined();
	});
});

/**
 * Two unpublished asset docs for R2 uploads that already finished.
 * Their `r2Key` is not set yet, and their normal cleanup time is still set.
 */
async function seed_unpublished_asset_pair(
	t: ReturnType<typeof test_convex>,
	db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const [yjsSnapshotAssetId, contentSnapshotAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "yjs_snapshot",
				r2Bucket: "test-files-bucket",
				size: 2,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 1000,
				updatedAt: now,
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-files-bucket",
				size: 2,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 1000,
				updatedAt: now,
			}),
		]);
		return { yjsSnapshotAssetId, contentSnapshotAssetId };
	});
}

function read_deletion_jobs(t: ReturnType<typeof test_convex>) {
	return t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
}

/** The R2 keys that deletion jobs must own for these assets, sorted for comparison. */
function expected_ledger_keys(
	db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
	assetIds: ReadonlyArray<Id<"files_r2_assets">>,
) {
	return assetIds
		.map((assetId) =>
			r2_create_asset_key({ organizationId: db.organizationId, workspaceId: db.workspaceId, assetId }),
		)
		.sort();
}

describe("files_nodes_content.create_file_node read-only barrier", () => {
	test("the create mutation publishes both assets and the first version snapshot atomically", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const textContent = "# Atomic create";
		const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_text({
			text: textContent,
			rootKind: "rich_text",
		});
		if (snapshotUpdate._nay) {
			throw new Error(snapshotUpdate._nay.message);
		}
		const assets = await seed_unpublished_asset_pair(t, db);
		await t.run(async (ctx) => {
			await Promise.all([
				ctx.db.patch("files_r2_assets", assets.yjsSnapshotAssetId, {
					size: snapshotUpdate._yay.byteLength,
				}),
				ctx.db.patch("files_r2_assets", assets.contentSnapshotAssetId, {
					size: files_get_utf8_byte_size(textContent),
				}),
			]);
		});

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "atomic-create.md",
			contentType: "text/markdown;charset=utf-8",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent,
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected an editable created node");
			}
			const [contentAsset, yjsSnapshot, snapshots] = await Promise.all([
				ctx.db.get("files_r2_assets", assets.contentSnapshotAssetId),
				ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId),
				ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("fileNodeId", created._yay.nodeId),
					)
					.collect(),
			]);
			const yjsAsset = yjsSnapshot ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
			expect(contentAsset).toMatchObject({
				r2Key: r2_create_asset_key({
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					assetId: assets.contentSnapshotAssetId,
				}),
			});
			expect(contentAsset?.unfinalizedExpiresAt).toBeUndefined();
			expect(yjsAsset).toMatchObject({
				r2Key: r2_create_asset_key({
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					assetId: assets.yjsSnapshotAssetId,
				}),
			});
			expect(yjsAsset?.unfinalizedExpiresAt).toBeUndefined();
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0]?.assetId).toBe(assets.contentSnapshotAssetId);
		});
	});

	test("a fresh barrier publishes the file and clears both creation deadlines", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Barrier Positive User",
		});

		// The public action checks the path, uploads both files, then checks the path again before saving.
		const created = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "barrier-positive.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected an editable created node");
			}

			// The successful final mutation published both assets and cleared both deadlines.
			const contentAsset = node.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			expect(contentAsset?.r2Key).toBeTruthy();
			expect(contentAsset?.unfinalizedExpiresAt).toBeUndefined();
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
			const yjsAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			expect(yjsAsset?.r2Key).toBeTruthy();
			expect(yjsAsset?.unfinalizedExpiresAt).toBeUndefined();

			// The initial version snapshot exists.
			const snapshots = await ctx.db
				.query("files_snapshots")
				.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", created._yay.nodeId),
				)
				.collect();
			expect(snapshots.length).toBeGreaterThan(0);
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("a newly hidden locked segment returns permission denied before its lock state", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Create Privacy Owner",
		});
		const outer = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "privacy-outer",
		});
		if (outer._nay) {
			throw new Error(outer._nay.message);
		}
		const hidden = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: outer._yay.nodeId,
			path: "hidden",
		});
		if (hidden._nay) {
			throw new Error(hidden._nay.message);
		}

		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_create_privacy_member" });
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});
			return { userId };
		});
		const preflight = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: member.userId,
			parentId: files_ROOT_ID,
			path: "privacy-outer/hidden/leaf.md",
		});
		if (!preflight) {
			throw new Error("Expected the member to capture the open destination");
		}
		const assets = await seed_unpublished_asset_pair(t, { ...db, userId: member.userId });

		// The segment becomes a hidden restricted scope and is locked while the action uploads.
		// The final mutation must check access before returning any lock or path conflict.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", hidden._yay.nodeId, {
				restrictedScopeNodeId: hidden._yay.nodeId,
			});
		});
		await set_read_only_or_throw(asOwner, db.membershipId, hidden._yay.nodeId);

		const refused = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: member.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "privacy-outer/hidden/leaf.md",
			contentType: "text/markdown;charset=utf-8",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "hidden",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		expect(refused._nay?.message).toBe("Permission denied");
		expect(refused._nay?.name).not.toBe("read_only");
		expect(await read_active_child(t, db, hidden._yay.nodeId, "leaf.md")).toBeNull();
		expect((await read_deletion_jobs(t)).map((job) => job.reason)).toEqual([
			"read_only_create",
			"read_only_create",
		]);
	});

	test("a create publishes when a lock is removed before the final mutation", async () => {
		const t = test_convex();
		const { db, asUser, innerId } = await seed_read_only_lock_tree(t);

		const preflight = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			parentId: innerId,
			path: "mid-lock.md",
		});
		if (!preflight) {
			throw new Error("Expected the current destination preflight to pass");
		}

		const assets = await seed_unpublished_asset_pair(t, db);
		await set_read_only_or_throw(asUser, db.membershipId, innerId);
		await set_writable_or_throw(asUser, db.membershipId, innerId);

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: innerId,
			path: "mid-lock.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "mid lock",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		expect((await read_active_child(t, db, innerId, "mid-lock.md"))?._id).toBe(created._yay.nodeId);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId)).not.toBeNull();
			expect(await ctx.db.get("files_r2_assets", assets.contentSnapshotAssetId)).not.toBeNull();
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("a currently locked destination refuses the prepared create and the action refuses before any upload", async () => {
		const t = test_convex();
		const { db, asUser, siblingId } = await seed_read_only_lock_tree(t);

		const preflight = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			parentId: siblingId,
			path: "prepared.md",
		});
		if (!preflight) {
			throw new Error("Expected a barrier for an existing destination");
		}
		const assets = await seed_unpublished_asset_pair(t, db);
		await set_read_only_or_throw(asUser, db.membershipId, siblingId);

		// The full action refuses at capture time, before creating any asset docs.
		const assetCountBefore = await t.run(async (ctx) => (await ctx.db.query("files_r2_assets").collect()).length);
		const actionRefused = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: siblingId,
			path: "action-blocked.md",
		});
		expect(actionRefused._nay?.name).toBe("read_only");
		expect(actionRefused._nay?.message).toBe("This item is read-only.");
		expect(await t.run(async (ctx) => (await ctx.db.query("files_r2_assets").collect()).length)).toBe(
			assetCountBefore,
		);

		// The prepared create (captured before the lock) refuses on the current lock in the final
		// mutation and hands its uploads to the ledger.
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("simulated R2 outage"));
		const refused = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: siblingId,
			path: "prepared.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "prepared",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		await t.finishInProgressScheduledFunctions();

		expect(await read_active_child(t, db, siblingId, "prepared.md")).toBeNull();
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", assets.contentSnapshotAssetId)).toBeNull();
		});
		const jobs = await read_deletion_jobs(t);
		expect(jobs.map((job) => job.reason)).toEqual(["read_only_create", "read_only_create"]);
	});

	test("a file created at the target during the action refuses the prepared create and hands the uploads to the ledger", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Raced Target User",
		});

		const barrier = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			parentId: files_ROOT_ID,
			path: "raced.md",
		});
		if (!barrier) {
			throw new Error("Expected a barrier for an absent target");
		}
		expect(barrier.targetNodeId).toBeNull();
		const assets = await seed_unpublished_asset_pair(t, db);

		// Another writer publishes the same path while the action is uploading.
		const winner = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "raced.md",
		});
		if (winner._nay) {
			throw new Error(winner._nay.message);
		}

		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("simulated R2 outage"));
		const refused = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "raced.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "raced",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		// The broken expectation is target absence, not a lock: this is a plain conflict.
		expect(refused._nay?.name).toBe("nay");
		expect(refused._nay?.message).toBe("This file already exists.");
		await t.finishInProgressScheduledFunctions();

		// The winner's file survives; only the loser's uploads went to the ledger.
		expect(await read_active_child(t, db, files_ROOT_ID, "raced.md")).not.toBeNull();
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", assets.contentSnapshotAssetId)).toBeNull();
		});
		const jobs = await read_deletion_jobs(t);
		expect(jobs.map((job) => job.reason)).toEqual(["read_only_create", "read_only_create"]);
		expect(jobs.map((job) => job.r2Key).sort()).toEqual(
			expected_ledger_keys(db, [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId]),
		);
	});

	test("a create publishes after an old prefix lock is removed and archived", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "ABA Epoch User",
		});

		const preflight = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			parentId: files_ROOT_ID,
			path: "aba/mid/leaf.md",
		});
		if (!preflight) {
			throw new Error("Expected the current destination preflight to pass");
		}

		const assets = await seed_unpublished_asset_pair(t, db);

		// While the action uploads, another writer creates, locks, unlocks, and archives the prefix.
		const aba = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "aba",
		});
		if (aba._nay) {
			throw new Error(aba._nay.message);
		}
		const mid = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: aba._yay.nodeId,
			path: "mid",
		});
		if (mid._nay) {
			throw new Error(mid._nay.message);
		}
		await set_read_only_or_throw(asUser, db.membershipId, mid._yay.nodeId);
		await set_writable_or_throw(asUser, db.membershipId, mid._yay.nodeId);
		for (const nodeId of [mid._yay.nodeId, aba._yay.nodeId]) {
			const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: db.membershipId,
				nodeIds: [nodeId],
			});
			if (archived._nay) {
				throw new Error(archived._nay.message);
			}
		}
		expect(await read_active_child(t, db, files_ROOT_ID, "aba")).toBeNull();

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "aba/mid/leaf.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "aba",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", created._yay.nodeId));
		expect(node?.path).toBe("/aba/mid/leaf.md");
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("the pending-create policy publishes after a completed lock cycle", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Current Lock Create User",
		});
		const assets = await seed_unpublished_asset_pair(t, db);

		// Simulate a prefix that appeared, locked, unlocked, and disappeared while the pending
		// create prepared its assets. Only the lock state in the final mutation matters here.
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "pending-cycle",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		await set_read_only_or_throw(asUser, db.membershipId, folder._yay.nodeId);
		await set_writable_or_throw(asUser, db.membershipId, folder._yay.nodeId);
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [folder._yay.nodeId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "pending-cycle/deep/leaf.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "pending",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", created._yay.nodeId));
		expect(node?.path).toBe("/pending-cycle/deep/leaf.md");
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("lock cycles on an archived folder do not stale creates that reuse its path", async () => {
		const t = test_convex();
		const { db, asUser, outerId, frozenId } = await seed_read_only_lock_tree(t);

		// /outer/frozen is archived, so the create walks past it and would recreate the folder.
		const preflight = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			parentId: outerId,
			path: "frozen/nested.md",
		});
		if (!preflight) {
			throw new Error("Expected the current destination preflight to pass");
		}

		const assets = await seed_unpublished_asset_pair(t, db);
		// A lock on an archived copy does not affect the new active path after it is removed.
		await set_read_only_or_throw(asUser, db.membershipId, frozenId);
		await set_writable_or_throw(asUser, db.membershipId, frozenId);

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: outerId,
			path: "frozen/nested.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "nested",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			expect(node?.path).toBe("/outer/frozen/nested.md");
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});
});

/**
 * A file with one restorable snapshot and the two unpublished snapshot assets a restore action
 * would have uploaded. The published snapshot asset keeps its r2Key; the current/restored pair
 * has none and still carries the insert-time cleanup deadline.
 */
async function seed_snapshot_restore_target(
	t: ReturnType<typeof test_convex>,
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>,
	path: string,
) {
	const createdFile = await t.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const nodeId = createdFile._yay.nodeId;

	return await t.run(async (ctx) => {
		const now = Date.now();
		const [snapshotAssetId, currentSnapshotAssetId, restoredSnapshotAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/restore-gate-snapshot`,
				size: 4,
				createdBy: db.userId,
				updatedAt: now,
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 1000,
				updatedAt: now,
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 4,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 1000,
				updatedAt: now,
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
		});
		return { nodeId, snapshotId, currentSnapshotAssetId, restoredSnapshotAssetId };
	});
}

/** Read every value that a refused restore must leave unchanged. */
function read_restore_write_surfaces(
	t: ReturnType<typeof test_convex>,
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>,
	nodeId: Id<"files_nodes">,
) {
	return t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", nodeId);
		const snapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect();
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect();
		const chunks = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect();
		return {
			assetId: node?.assetId,
			snapshotCount: snapshots.length,
			yjsUpdateCount: yjsUpdates.length,
			chunkText: chunks.map((chunk) => chunk.plainTextChunk).join(""),
		};
	});
}

describe("files_nodes_content.restore_snapshot read-only gates", () => {
	test("a locked file refuses the prepared restore before any write and hands both keys to the ledger", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Restore Lock User",
		});
		const seeded = await seed_snapshot_restore_target(t, db, "/restore-lock.md");
		const before = await read_restore_write_surfaces(t, db, seeded.nodeId);

		await set_read_only_or_throw(asUser, db.membershipId, seeded.nodeId);
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("simulated R2 outage"));

		// The live lock refuses the restore.
		const refused = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
			membershipId: db.membershipId,
			nodeId: seeded.nodeId,
			snapshotId: seeded.snapshotId,
			sessionId: "restore-lock-test",
			snapshotMarkdownContent: "# restored\n",
			currentSnapshotAssetId: seeded.currentSnapshotAssetId,
			currentSnapshotSize: 0,
			restoredSnapshotAssetId: seeded.restoredSnapshotAssetId,
			restoredSnapshotSize: 4,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		await t.finishInProgressScheduledFunctions();

		// Nothing was written: node pointer, snapshot history, Yjs updates, and chunks are as before.
		expect(await read_restore_write_surfaces(t, db, seeded.nodeId)).toEqual(before);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", seeded.currentSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", seeded.restoredSnapshotAssetId)).toBeNull();
		});
		const jobs = await read_deletion_jobs(t);
		expect(jobs.map((job) => job.reason)).toEqual(["read_only_snapshot_restore", "read_only_snapshot_restore"]);
		expect(jobs.map((job) => job.r2Key).sort()).toEqual(
			expected_ledger_keys(db, [seeded.currentSnapshotAssetId, seeded.restoredSnapshotAssetId]),
		);
	});

	test("handed-off ledger jobs survive failing delete attempts with attempts recorded", async () => {
		// Fake timers make the runAfter(0) processors start deterministically before the readback.
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				external_id: db.userId,
				name: "Restore Retry User",
			});
			const seeded = await seed_snapshot_restore_target(t, db, "/restore-retry.md");
			await set_read_only_or_throw(asUser, db.membershipId, seeded.nodeId);

			// Every confirmed delete fails: the exact keys must stay in the ledger for the retry
			// backoff and the hourly sweep, never silently dropped.
			vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("simulated R2 outage"));
			const refused = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
				membershipId: db.membershipId,
				nodeId: seeded.nodeId,
				snapshotId: seeded.snapshotId,
				sessionId: "restore-retry-test",
				snapshotMarkdownContent: "# restored\n",
				currentSnapshotAssetId: seeded.currentSnapshotAssetId,
				currentSnapshotSize: 0,
				restoredSnapshotAssetId: seeded.restoredSnapshotAssetId,
				restoredSnapshotSize: 4,
			});
			expect(refused._nay?.name).toBe("read_only");

			// Fire the runAfter(0) processors, then wait for their failure records to land.
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();

			const jobs = await read_deletion_jobs(t);
			expect(jobs.length).toBe(2);
			for (const job of jobs) {
				expect(job.reason).toBe("read_only_snapshot_restore");
				expect(job.attempts).toBe(1);
				expect(job.nextAttemptAt).toBeGreaterThan(Date.now());
			}
		} finally {
			vi.useRealTimers();
		}
	});

	test("restore succeeds after unlock and clears both deadlines", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", {
				clerkUserId: "clerk-restore-readonly-user",
			});
			return await test_mocks_fill_db_with.membership(ctx, { userId });
		});
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Restore Unlocked User",
			email: "restore-readonly-user@example.com",
		});
		const seeded = await seed_snapshot_restore_target(t, db, "/restore-unlocked.md");

		// Only the lock state in the final mutation matters.
		await set_read_only_or_throw(asUser, db.membershipId, seeded.nodeId);
		await set_writable_or_throw(asUser, db.membershipId, seeded.nodeId);

		const restoredMarkdown = "# restored content\n";
		const restoreStage = await t.mutation(internal.files_pending_updates.stage_trusted_yjs_update, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: seeded.nodeId,
			kind: "snapshot_restore",
			update: files_u8_to_array_buffer(
				encodeStateAsUpdate(
					(() => {
						const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: restoredMarkdown });
						if ("_nay" in yjsDoc) {
							throw new Error("Expected restored markdown to produce a Yjs doc");
						}

						return yjsDoc;
					})(),
				),
			),
		});
		if (restoreStage._nay) {
			throw new Error(restoreStage._nay.message);
		}

		const restored = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
			membershipId: db.membershipId,
			nodeId: seeded.nodeId,
			snapshotId: seeded.snapshotId,
			sessionId: "restore-unlocked-test",
			snapshotMarkdownContent: restoredMarkdown,
			currentSnapshotAssetId: seeded.currentSnapshotAssetId,
			currentSnapshotSize: 0,
			restoredSnapshotAssetId: seeded.restoredSnapshotAssetId,
			restoredSnapshotSize: files_get_utf8_byte_size(restoredMarkdown),
			restoreUpdateStageId: restoreStage._yay.stageId,
		});
		if (restored._nay) {
			throw new Error(`Expected restore to succeed, got: ${restored._nay.message}`);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).toBe(seeded.restoredSnapshotAssetId);
			// The success path published both assets and cleared both cleanup deadlines.
			const currentAsset = await ctx.db.get("files_r2_assets", seeded.currentSnapshotAssetId);
			expect(currentAsset?.r2Key).toBeTruthy();
			expect(currentAsset?.unfinalizedExpiresAt).toBeUndefined();
			const restoredAsset = await ctx.db.get("files_r2_assets", seeded.restoredSnapshotAssetId);
			expect(restoredAsset?.r2Key).toBeTruthy();
			expect(restoredAsset?.unfinalizedExpiresAt).toBeUndefined();
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});
});

/**
 * A durably marked file plus the three asset docs a repair action hands to its final mutation:
 * the two fresh unpublished uploads and the superseded Yjs snapshot asset.
 */
async function seed_repair_finalize_target(
	t: ReturnType<typeof test_convex>,
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>,
	path: string,
) {
	const created = await t.action(internal.files_nodes_content.create_file_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
	});
	if (created._nay) {
		throw new Error(created._nay.message);
	}
	const nodeId = created._yay.nodeId;
	await t.run(async (ctx) => {
		await ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() });
	});

	const [yjsSnapshotAssetId, contentSnapshotAssetId, supersededYjsAssetId] = await t.run(async (ctx) => {
		const now = Date.now();
		return await Promise.all([
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "yjs_snapshot",
				r2Bucket: "test-files-bucket",
				size: 2,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 1000,
				updatedAt: now,
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-files-bucket",
				size: 6,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 1000,
				updatedAt: now,
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "yjs_snapshot",
				r2Bucket: "test-files-bucket",
				size: 2,
				createdBy: db.userId,
				updatedAt: now,
			}),
		]);
	});
	return { nodeId, yjsSnapshotAssetId, contentSnapshotAssetId, supersededYjsAssetId };
}

describe("files_nodes_content.cleanup_file_yjs_repair_covered_rows", () => {
	test("durably deletes the superseded Yjs object after a confirmed delete retry", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/repair-superseded-cleanup.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const superseded = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected an editable repair target");
			}
			const snapshot = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
			if (!snapshot) {
				throw new Error("Expected a Yjs snapshot");
			}
			const asset = await ctx.db.get("files_r2_assets", snapshot.assetId);
			if (!asset?.r2Key) {
				throw new Error("Expected a published Yjs snapshot asset");
			}

			const replacementAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "yjs_snapshot",
				r2Bucket: "test-files-bucket",
				size: 2,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			await ctx.db.patch("files_yjs_snapshots", snapshot._id, { assetId: replacementAssetId });

			return { assetId: asset._id, key: asset.r2Key, throughSequence: snapshot.sequence };
		});

		const finiteDeleteSpy = vi.spyOn(R2.prototype, "deleteObject");
		const confirmedDeleteSpy = vi
			.spyOn(r2_confirmed_object_delete, "delete_object")
			.mockRejectedValueOnce(new Error("simulated R2 outage"));

		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_repair_covered_rows, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: created._yay.nodeId,
			throughSequence: superseded.throughSequence,
			supersededYjsAssetId: superseded.assetId,
		});
		expect(finiteDeleteSpy).not.toHaveBeenCalled();
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", superseded.assetId))).toBeNull();

		const [job] = await read_deletion_jobs(t);
		expect(job).toMatchObject({ r2Key: superseded.key, reason: "untracked_asset_event", generation: 1 });
		if (!job) {
			throw new Error("Expected a superseded-object deletion job");
		}
		await t.action(internal.r2_client.process_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
		});
		expect((await read_deletion_jobs(t))[0]).toMatchObject({
			r2Key: superseded.key,
			attempts: 1,
		});

		confirmedDeleteSpy.mockResolvedValue(undefined);
		await t.action(internal.r2_client.process_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});
});

describe("files_nodes_content.finalize_file_yjs_repair read-only gates", () => {
	test("a locked file refuses finalize before the staleness checks and hands both keys to the ledger", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Repair Lock User",
		});
		const seeded = await seed_repair_finalize_target(t, db, "/repair-gate-lock.md");
		await set_read_only_or_throw(asUser, db.membershipId, seeded.nodeId);
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("simulated R2 outage"));

		// `targetSequence` is deliberately stale. A `read_only` result proves the lock check runs
		// before the staleness checks, so no later check can publish first.
		const refused = await t.mutation(internal.files_nodes_content.finalize_file_yjs_repair, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: seeded.nodeId,
			authorUserId: db.userId,
			source: "latest_state",
			acknowledgeDiscardUnmaterialized: false,
			targetSequence: 999,
			expectedLineageGeneration: 0,
			text: "repair.",
			textByteSize: files_get_utf8_byte_size("repair."),
			yjsSnapshotAssetId: seeded.yjsSnapshotAssetId,
			yjsSnapshotSize: 2,
			contentSnapshotAssetId: seeded.contentSnapshotAssetId,
			supersededYjsAssetId: seeded.supersededYjsAssetId,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		await t.finishInProgressScheduledFunctions();

		// The fresh uploads went to the ledger; the node, its markers, and the superseded asset
		// are untouched.
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", seeded.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", seeded.contentSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", seeded.supersededYjsAssetId)).not.toBeNull();
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.contentShapeMismatchAt).toBeDefined();
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected the node to stay editable");
			}
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
			expect(lastSequenceDoc?.lineageGeneration).toBe(0);
		});
		const jobs = await read_deletion_jobs(t);
		expect(jobs.map((job) => job.reason)).toEqual(["read_only_yjs_repair", "read_only_yjs_repair"]);
		expect(jobs.map((job) => job.r2Key).sort()).toEqual(
			expected_ledger_keys(db, [seeded.yjsSnapshotAssetId, seeded.contentSnapshotAssetId]),
		);
	});

	test("the repair action refuses a locked file before creating any assets", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Repair Early Refusal User",
		});
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/repair-early-refusal.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", created._yay.nodeId, { contentShapeMismatchAt: Date.now() });
		});
		await set_read_only_or_throw(asUser, db.membershipId, created._yay.nodeId);

		const assetCountBefore = await t.run(async (ctx) => (await ctx.db.query("files_r2_assets").collect()).length);
		const refused = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: created._yay.nodeId,
			authorUserId: db.userId,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");

		expect(await t.run(async (ctx) => (await ctx.db.query("files_r2_assets").collect()).length)).toBe(
			assetCountBefore,
		);
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("repair succeeds after unlock and clears both upload deadlines", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Repair Unlocked User",
		});
		const r2Writes = new Map<string, BodyInit>();
		generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
			const key = customKey ?? "test-upload-key";
			return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
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

		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/repair-unlocked.md",
			textContent: "# Repair me\n\nBody text\n",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const nodeId = created._yay.nodeId;

		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (materialized._nay) {
			throw new Error(materialized._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() });
		});

		// The operator unlocked before repairing, so the final mutation accepts it.
		await set_read_only_or_throw(asUser, db.membershipId, nodeId);
		await set_writable_or_throw(asUser, db.membershipId, nodeId);

		const repaired = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
		});
		if (repaired._nay) {
			throw new Error(repaired._nay.message);
		}
		expect(repaired._yay.lineageGeneration).toBe(1);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected the repaired node to stay editable");
			}
			expect(node.contentShapeMismatchAt).toBeUndefined();

			// The repair's published uploads carry keys and no cleanup deadline.
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
			const yjsAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			expect(yjsAsset?.r2Key).toBeTruthy();
			expect(yjsAsset?.unfinalizedExpiresAt).toBeUndefined();
			const contentAsset = node.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			expect(contentAsset?.r2Key).toBeTruthy();
			expect(contentAsset?.unfinalizedExpiresAt).toBeUndefined();
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});
});
