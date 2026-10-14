import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import type { FunctionReturnType } from "convex/server";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { Doc as YjsDoc, encodeStateAsUpdate } from "yjs";
import { api, components, internal } from "./_generated/api.js";
import { db_insert_file_text_content } from "./files_nodes_content.ts";
import { files_nodes_db_archive_node, files_nodes_db_restore_node } from "./files_nodes.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_metadata_db_insert_committed } from "./files_metadata.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import {
	test_apply_file_pending_move,
	test_compact_metadata_catalog,
	test_convex,
	test_finish_saved_scope_jobs,
	test_rename_node,
	test_move_nodes,
	test_get_file_yjs_pointers,
	test_meta_search,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { files_ROOT_ID, files_u8_to_array_buffer } from "../server/files.ts";
import {
	files_yjs_doc_create_from_text,
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
} from "../shared/files-tiptap.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import type { Id } from "./_generated/dataModel.js";
import type { files_metadata_Entry, files_metadata_SearchPlan } from "../shared/files-metadata.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_table_filter_order_field, type files_table_Filter } from "../shared/files-table.ts";
import {
	seed_folder_table,
	seed_billing_snapshot_for_user,
	upsert_pending_update_internal_for_test,
	propose_move_for_test,
	test_setup_r2_capture,
	test_materialize_markdown_file,
	text_search_files_all_pages,
} from "./files_nodes.setup.test.ts";

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

// Tests that run the real SDK set this fake provider model. The receipt middleware stays real.
const inlineAiProvider = vi.hoisted(() => ({ model: null as MockLanguageModelV3 | null }));
vi.mock("@ai-sdk/openai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ai-sdk/openai")>();
	return {
		...actual,
		openai: Object.assign(() => inlineAiProvider.model, actual.openai),
	};
});

const test = baseTest;

beforeEach(() => {
	generateTextMock.mockReset();
	streamTextMock.mockReset();
	inlineAiProvider.model = null;
	// Keep file tests focused on file behavior; billing event enqueue behavior is
	// covered in billing tests.
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_test_billing_event" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

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

async function test_insert_searchable_markdown_file(args: {
	t: ReturnType<typeof test_convex>;
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
	path: string;
	markdown: string;
}) {
	const { t, db, path, markdown } = args;

	// Seed only the node and committed plain-text chunk docs for tests that exercise search scope.
	return await t.run(async (ctx) => {
		const now = Date.now();
		const name = path.split("/").filter(Boolean).at(-1);
		if (!name) throw new Error("Expected a root-level file path");
		const nodeId = await ctx.db.insert("files_nodes", {
			assetId: null,
			contentByteSize: null,
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: null,
			isRestrictedScopeRoot: false,
			writePolicy: null,

			archiveOperationId: null,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path,
			treePath: path,
			pathDepth: 1,
			lowercaseExtension: "md",
			name,
			sortName: files_sort_text_key(name),
			kind: "file",
			contentType: "text/markdown;charset=utf-8",
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: now,
			newChildWritePolicy: null,
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

describe("search_paths", () => {
	test.each(["😀", "\uffff"])("includes a %s folder in a scoped path search", async (suffix) => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: `scope/${suffix}folder`,
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: folder._yay.nodeId,
			filename: "needle.png",
			contentType: "image/png",
			size: 1,
		});
		if (upload._nay) throw new Error(upload._nay.message);
		const path = `/scope/${suffix}folder/needle.png`;
		for (const pathPrefix of [undefined, "/scope"]) {
			const result = await t.query(internal.files_nodes.search_paths, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				visibilityUserId: db.userId,
				pathQuery: path,
				numItems: 50,
				cursor: null,
				kind: "file",
				pathPrefix,
			});
			expect(result.items.map((item) => item.path)).toEqual([path]);
		}
	});
});

describe("text_search_files", () => {
	test.each(["😀", "\uffff"])("includes a %s descendant and excludes a sibling prefix", async (suffix) => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run((ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		test_setup_r2_capture();
		const path = `/scope/${suffix}folder/inside.md`;
		const nodeId = await test_materialize_markdown_file({
			t,
			asUser,
			db,
			path: "/scope/inside.md",
			markdown: "prefixneedle",
		});
		// The saved folder door allows a wider alphabet than the agent create door.
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: `scope/${suffix}folder`,
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const moved = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [nodeId],
			targetParentId: folder._yay.nodeId,
		});
		expect(moved._nay).toBeUndefined();
		await test_materialize_markdown_file({ t, asUser, db, path: "/scope-other/outside.md", markdown: "prefixneedle" });
		for (const pathPrefix of [undefined, "/scope"]) {
			const result = await text_search_files_all_pages(asUser, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				hasWorkspaceRead: true,
				query: "prefixneedle",
				numItems: 50,
				cursor: null,
				pathPrefix,
			});
			expect(new Set(result.items.map((item) => item.path))).toEqual(
				new Set(pathPrefix === undefined ? [path, "/scope-other/outside.md"] : [path]),
			);
		}
	});
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
	await test_materialize_markdown_file({ t, asUser, db, path: "/scope/inside.md", markdown: body("inside") });
	await test_materialize_markdown_file({ t, asUser, db, path: "/scope-other/collide.md", markdown: body("collide") });

	const search = (args: { pathPrefix: string | undefined; numItems: number; cursor?: string | null }) => {
		const { cursor = null, numItems, pathPrefix } = args;

		return text_search_files_all_pages(asUser, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query: "scopeneedle",
			numItems,
			cursor,
			pathPrefix,
		});
	};

	// Unscoped: both files match.
	const all = await search({ pathPrefix: undefined, numItems: 50 });
	expect(new Set(all.items.map((i) => i.path))).toEqual(new Set(["/scope/inside.md", "/scope-other/collide.md"]));

	// Pages of one row: each page holds at most one, and the cursor reads on to the rest.
	const pagedPaths: string[] = [];
	let cursor: string | null = null;
	for (let guard = 0; guard < 10; guard++) {
		const page: FunctionReturnType<typeof internal.files_nodes.text_search_files> = await asUser.query(
			internal.files_nodes.text_search_files,
			{
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				hasWorkspaceRead: true,
				query: "scopeneedle",
				numItems: 1,
				cursor,
			},
		);
		expect(page.items.length).toBeLessThanOrEqual(1);
		pagedPaths.push(...page.items.map((i) => i.path));
		if (page.isDone) break;
		cursor = page.continueCursor;
	}
	expect(new Set(pagedPaths)).toEqual(new Set(["/scope/inside.md", "/scope-other/collide.md"]));

	// Scoped to /scope: only the file under /scope, NOT the sibling-prefix /scope-other file.
	const scoped = await search({ pathPrefix: "/scope", numItems: 50 });
	expect(scoped.items.map((i) => i.path)).toEqual(["/scope/inside.md"]);

	// Scoped to the sibling prefix: only its file (the collision is rejected in both directions).
	const scopedOther = await search({ pathPrefix: "/scope-other", numItems: 50 });
	expect(scopedOther.items.map((i) => i.path)).toEqual(["/scope-other/collide.md"]);

	// Limit applied AFTER the path filter: with limit 1 and an out-of-scope match also present, the
	// single in-scope match is still returned (an out-of-scope match must not consume the limit).
	const scopedTinyLimit = await search({ pathPrefix: "/scope", numItems: 1 });
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
	const nodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path,
		markdown: "# Plan\n\ncommittedneedle appears only in the committed version.",
	});
	const otherNodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: otherPath,
		markdown: "# Other\n\nsharedneedle lives in another committed file.",
	});

	const search = (query: string) =>
		text_search_files_all_pages(asUser, {
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

	const otherUserId = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: null });
		const now = Date.now();
		await ctx.db.insert("organizations_workspaces_users", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
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
		return userId;
	});
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
			.withIndex("by_organization_workspace_user_target", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("userId", db.userId)
					.eq("target.kind", "saved")
					.eq("target.id", nodeId),
			)
			.first();
		if (!pendingDoc) throw new Error("Expected pending doc");
		const plainTextChunk = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) =>
				q
					.eq("pendingUpdateId", pendingDoc._id)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.eq("chunkIndex", expectedChunk.chunkIndex),
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
			target: { kind: "saved", id: nodeId },
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

	const otherUserCommittedSearch = await text_search_files_all_pages(asUser, {
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

	await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/meta/invoice.md",
		markdown: [
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
	});
	await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/meta-other/outside.md",
		markdown: ["---", "from: alice@example.com", "amount: 300", "sentAt: 2026-06-01", "---", "Outside"].join("\n"),
	});

	const search = (plan: files_metadata_SearchPlan, folderPath?: string) =>
		test_meta_search(t, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan,
			folderPath,
		});

	const fromAlice = await search({ op: "eq", fieldPath: "frontmatter.from", value: "alice@example.com" });
	expect(new Set(fromAlice.items.map((item) => item.path))).toEqual(
		new Set(["/meta/invoice.md", "/meta-other/outside.md"]),
	);

	const copiedToBob = await search({ op: "eq", fieldPath: "frontmatter.cc", value: "bob@example.com" });
	expect(copiedToBob.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const invoiceSubject = await search({ op: "prefix", fieldPath: "frontmatter.subject", value: "Invoice" });
	expect(invoiceSubject.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const amountRange = await search({
		op: "range",
		fieldPath: "frontmatter.amount",
		valueKind: "number",
		gte: 100,
		lt: 200,
	});
	expect(amountRange.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	// Use sentAt to prove that maybe_date companion docs make YAML strings range-searchable.
	const sentInWindow = await search({
		op: "range",
		fieldPath: "frontmatter.sentAt",
		valueKind: "maybe_date",
		gte: Date.UTC(2026, 6, 27),
		lt: Date.UTC(2026, 7, 2),
	});
	expect(sentInWindow.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const amountStringMismatch = await search({ op: "eq", fieldPath: "frontmatter.amount", value: "120.5" });
	expect(amountStringMismatch.items).toEqual([]);

	const amountString = await search({ op: "eq", fieldPath: "frontmatter.amountString", value: "120.5" });
	expect(amountString.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const booleanNumberMismatch = await search({ op: "eq", fieldPath: "frontmatter.hasAttachments", value: 1 });
	expect(booleanNumberMismatch.items).toEqual([]);

	const hasAttachments = await search({ op: "eq", fieldPath: "frontmatter.hasAttachments", value: true });
	expect(hasAttachments.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const scoped = await search({ op: "exists", fieldPath: "frontmatter.from" }, "/meta");
	expect(scoped.items.map((item) => item.path)).toEqual(["/meta/invoice.md"]);

	const metadata = await asUser.query(internal.files_metadata.get_index_values_by_path, {
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
			expect.objectContaining({ fieldPath: "frontmatter.amount", valueKind: "number", numberValue: 120.5 }),
			expect.objectContaining({
				fieldPath: "frontmatter.amountString",
				valueKind: "string",
				stringValue: "120.5",
			}),
			expect.objectContaining({
				fieldPath: "frontmatter.sentAt",
				valueKind: "string",
				stringValue: "2026-07-29T14:30:00Z",
			}),
			expect.objectContaining({
				fieldPath: "frontmatter.sentAt",
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
	const nodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path,
		markdown: [
			"---",
			"from: committed@example.com",
			"subject: Committed subject",
			"sentAt: 2026-06-01",
			"---",
			"Committed body",
		].join("\n"),
	});

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

	const otherUserId = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: null });
		await ctx.db.insert("organizations_workspaces_users", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			role: "member",
			now: Date.now(),
		});
		return userId;
	});

	const searchAs = (userId: Id<"users">, value: string) =>
		test_meta_search(t, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			plan: { op: "eq", fieldPath: "frontmatter.from", value },
		});

	const pendingHit = await searchAs(db.userId, "pending@example.com");
	expect(pendingHit.items).toMatchObject([{ path, match: { sourceKind: "pending" } }]);

	const pendingMetadata = await asUser.query(internal.files_metadata.get_index_values_by_path, {
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
				fieldPath: "frontmatter.from",
				valueKind: "string",
				stringValue: "pending@example.com",
			}),
		]),
	});

	const staleCommittedMiss = await searchAs(db.userId, "committed@example.com");
	expect(staleCommittedMiss.items).toEqual([]);

	const otherUserCommittedHit = await searchAs(otherUserId, "committed@example.com");
	expect(otherUserCommittedHit.items).toMatchObject([{ path, match: { sourceKind: "committed" } }]);

	const otherUserPendingMiss = await searchAs(otherUserId, "pending@example.com");
	expect(otherUserPendingMiss.items).toEqual([]);

	// Include both committed and pending dates in the window. One pending doc then proves the
	// overlay hides the committed doc instead of excluding it by range.
	const dateRangeAs = (userId: Id<"users">) =>
		test_meta_search(t, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			plan: {
				op: "range",
				fieldPath: "frontmatter.sentAt",
				valueKind: "maybe_date",
				gte: Date.UTC(2026, 5, 1),
				lt: Date.UTC(2026, 7, 1),
			},
		});

	const pendingDateHit = await dateRangeAs(db.userId);
	expect(pendingDateHit.items).toMatchObject([{ path, match: { sourceKind: "pending" } }]);

	const otherUserDateHit = await dateRangeAs(otherUserId);
	expect(otherUserDateHit.items).toMatchObject([{ path, match: { sourceKind: "committed" } }]);
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
	const nodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path,
		markdown: ["---", "from: committed@example.com", "---", "Committed body"].join("\n"),
	});

	// A pure move row (mv without edits) carries no content and must not mask metadata.
	// Fake timers let the test run the overlay job that writes the moved file's place fields.
	vi.useFakeTimers();
	try {
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved", id: nodeId },
			destParent: { kind: "root" },
			destName: "meta-moved.md",
		});
		if (moved._nay) throw new Error(moved._nay.message);
		vi.advanceTimersByTime(1);
		await t.finishInProgressScheduledFunctions();
	} finally {
		vi.useRealTimers();
	}

	const search = () =>
		test_meta_search(t, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan: { op: "eq", fieldPath: "frontmatter.from", value: "committed@example.com" },
		});

	// Search still surfaces the file's committed metadata docs.
	const committedHit = await search();
	expect(committedHit.items).toMatchObject([
		{ path: "/meta-moved.md", target: { kind: "saved", id: nodeId }, match: { sourceKind: "committed" } },
	]);

	// The get path resolves the visible destination and reports committed metadata.
	const metadata = await asUser.query(internal.files_metadata.get_index_values_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/meta-moved.md",
		overlayUserId: db.userId,
	});
	expect(metadata).toMatchObject({
		path: "/meta-moved.md",
		target: { kind: "saved", id: nodeId },
		sourceKind: "committed",
		fields: expect.arrayContaining(["frontmatter.from"]),
		values: expect.arrayContaining([
			expect.objectContaining({
				fieldPath: "frontmatter.from",
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

	const pendingMetadata = await asUser.query(internal.files_metadata.get_index_values_by_path, {
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
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Metadata Scope User",
		email: "metadata-scope-user@example.com",
	});
	test_setup_r2_capture();

	const nodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/metadata-scope/source.md",
		markdown: ["---", "scope: metadata-scope-value", "---", "Body"].join("\n"),
	});
	const targetFolderId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			contentType: null,
			assetId: null,
			contentByteSize: null,
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: null,
			isRestrictedScopeRoot: false,
			writePolicy: null,

			archiveOperationId: null,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "/metadata-target",
			treePath: "/metadata-target/",
			pathDepth: 1,
			lowercaseExtension: null,
			name: "metadata-target",
			sortName: files_sort_text_key("metadata-target"),
			kind: "folder",
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: Date.now(),
			newChildWritePolicy: null,
		}),
	);

	const search = (folderPath?: string) =>
		test_meta_search(t, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan: { op: "eq", fieldPath: "frontmatter.scope", value: "metadata-scope-value" },
			folderPath,
		});

	expect((await search()).items.map((item) => item.path)).toEqual(["/metadata-scope/source.md"]);

	const renamed = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId,
		path: "renamed.md",
	});
	if (renamed._nay) throw new Error(renamed._nay.message);
	expect((await search()).items.map((item) => item.path)).toEqual(["/metadata-scope/renamed.md"]);

	const moved = await test_move_nodes(t, asUser, {
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

	const nodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/metadata-archive/source.md",
		markdown: ["---", "scope: metadata-archive-value", "---", "Body"].join("\n"),
	});

	const search = () =>
		test_meta_search(t, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan: { op: "eq", fieldPath: "frontmatter.scope", value: "metadata-archive-value" },
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
	const nodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path,
		markdown: ["---", "title: From frontmatter", "---", "First body"].join("\n"),
	});

	const written = await asUser.mutation(api.files_metadata.set_entries, {
		membershipId: db.membershipId,
		fileNodeId: nodeId,
		metadataYaml: [
			"title: From metadata",
			"created-by: slack",
			"slack-message-id: '1755500000.001'",
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
		{ key: "slack-message-id", value: "1755500000.001" },
		{ key: "priority", value: 3 },
		{ key: "archived", value: false },
		{ key: "released-on", value: "2026-08-18" },
	]);

	const search = (plan: files_metadata_SearchPlan, folderPath?: string) =>
		test_meta_search(t, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan,
			folderPath,
		});

	// The same key name on both sources stays two separate fields.
	expect((await search({ op: "eq", fieldPath: "metadata.title", value: "From metadata" })).items).toMatchObject([
		{ path, target: { kind: "saved", id: nodeId } },
	]);
	expect((await search({ op: "eq", fieldPath: "frontmatter.title", value: "From frontmatter" })).items).toMatchObject([
		{ path, target: { kind: "saved", id: nodeId } },
	]);
	expect((await search({ op: "eq", fieldPath: "metadata.title", value: "From frontmatter" })).items).toEqual([]);

	expect((await search({ op: "exists", fieldPath: "metadata.slack-message-id" })).items).toMatchObject([
		{ path, target: { kind: "saved", id: nodeId } },
	]);
	expect(
		(await search({ op: "range", fieldPath: "metadata.priority", valueKind: "number", gte: 1, lt: 5 })).items,
	).toMatchObject([{ path, target: { kind: "saved", id: nodeId } }]);
	expect((await search({ op: "eq", fieldPath: "metadata.archived", value: false })).items).toMatchObject([
		{ path, target: { kind: "saved", id: nodeId } },
	]);
	// A date-like string gets the same maybe_date companion frontmatter gets.
	expect(
		(
			await search({
				op: "range",
				fieldPath: "metadata.released-on",
				valueKind: "maybe_date",
				gte: Date.UTC(2026, 7, 17),
				lt: Date.UTC(2026, 7, 19),
			})
		).items,
	).toMatchObject([{ path, target: { kind: "saved", id: nodeId } }]);

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
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
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
		{ key: "slack-message-id", value: "1755500000.001" },
		{ key: "priority", value: 3 },
		{ key: "archived", value: false },
		{ key: "released-on", value: "2026-08-18" },
	]);
	expect((await search({ op: "eq", fieldPath: "metadata.title", value: "From metadata" })).items).toMatchObject([
		{ path, target: { kind: "saved", id: nodeId } },
	]);
	// Metadata docs carry their own copy of the file's tree path, so folder-scoped search must find
	// them in the file's folder and must not find them under another one.
	expect((await search({ op: "exists", fieldPath: "metadata.title" }, "/file-metadata")).items).toMatchObject([
		{ path, target: { kind: "saved", id: nodeId } },
	]);
	expect((await search({ op: "exists", fieldPath: "metadata.title" }, "/elsewhere")).items).toEqual([]);

	// The save must also still delete the frontmatter docs it replaces. The push above merges a second
	// Yjs document into the first one, and Yjs orders two concurrent inserts by a random client id, so
	// which frontmatter block ends up on top is not decided here. Exactly one of the two titles must
	// match: two matches would mean the narrowed delete stopped deleting.
	const oldTitle = await search({ op: "eq", fieldPath: "frontmatter.title", value: "From frontmatter" });
	const newTitle = await search({ op: "eq", fieldPath: "frontmatter.title", value: "Rewritten frontmatter" });
	expect(oldTitle.items.length + newTitle.items.length).toBe(1);

	// A second write replaces the whole map: the dropped keys stop being searchable.
	const replaced = await asUser.mutation(api.files_metadata.set_entries, {
		membershipId: db.membershipId,
		fileNodeId: nodeId,
		metadataYaml: "title: Only key left\n",
	});
	if (replaced._nay) throw new Error(replaced._nay.message);
	expect(await entries()).toEqual([{ key: "title", value: "Only key left" }]);
	expect((await search({ op: "exists", fieldPath: "metadata.priority" })).items).toEqual([]);
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
	const nodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path,
		markdown: ["---", "from: committed@example.com", "---", "Body"].join("\n"),
	});
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
		test_meta_search(t, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			plan,
		});

	// The pending edit replaces what the file's own frontmatter says.
	expect((await search({ op: "eq", fieldPath: "frontmatter.from", value: "committed@example.com" })).items).toEqual([]);
	// It says nothing about the metadata written next to the file, so that stays findable.
	expect((await search({ op: "eq", fieldPath: "metadata.source", value: "slack" })).items).toMatchObject([
		{ path, target: { kind: "saved", id: nodeId } },
	]);

	const metadata = await asUser.query(internal.files_metadata.get_index_values_by_path, {
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
	expect(metadata?.values.map((value) => [value.fieldPath, value.stringValue])).toEqual([
		["metadata.source", "slack"],
		["frontmatter.from", "pending@example.com"],
	]);
});

test("set_entries accepts folders and refuses bad YAML and read-only nodes", async () => {
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

	const nodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/file-metadata-refusal/note.md",
		markdown: "Body\n",
	});
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
	expect(await setEntries(nodeId, '"slack:message-id": yes\n')).toMatchObject({
		_nay: { message: expect.stringContaining("may contain only letters") },
	});

	const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "metadata-folder",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	expect(await setEntries(folder._yay.nodeId, "title: on a folder\n")).toMatchObject({
		_yay: null,
	});
	expect(
		await asUser.query(api.files_metadata.get_entries, {
			membershipId: db.membershipId,
			fileNodeId: folder._yay.nodeId,
		}),
	).toEqual([{ key: "title", value: "on a folder" }]);
	const lockedFolder = await asUser.mutation(api.files_nodes.set_node_write_policy, {
		writePolicy: { mode: "read_only" },
		membershipId: db.membershipId,
		nodeId: folder._yay.nodeId,
	});
	if (lockedFolder._nay) throw new Error(lockedFolder._nay.message);
	expect(await setEntries(folder._yay.nodeId, "title: changed\n")).toMatchObject({
		_nay: { name: "read_only", message: "This item is read-only." },
	});

	const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
		writePolicy: { mode: "read_only" },
		membershipId: db.membershipId,
		nodeId,
	});
	if (locked._nay) throw new Error(locked._nay.message);
	expect(await setEntries(nodeId, "title: on a locked file\n")).toMatchObject({ _nay: { name: "read_only" } });
	expect(
		await asUser.query(api.files_metadata.get_entries, { membershipId: db.membershipId, fileNodeId: nodeId }),
	).toEqual([]);
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
	expect(
		await asUser.query(api.files_metadata.get_entries, { membershipId: db.membershipId, fileNodeId: nodeId }),
	).toEqual(second._yay.entries);

	expect(
		(
			await test_meta_search(t, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				plan: { op: "eq", fieldPath: "metadata.status", value: "signed" },
			})
		).items,
	).toMatchObject([{ path, target: { kind: "saved", id: nodeId } }]);

	expect(await setByPath([{ key: "with space", value: "x" }], [])).toMatchObject({
		_nay: { message: expect.stringContaining("may contain only letters") },
	});

	const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
		writePolicy: { mode: "read_only" },
		membershipId: db.membershipId,
		nodeId,
	});
	if (locked._nay) throw new Error(locked._nay.message);
	expect(await setByPath([{ key: "status", value: "tampered" }], [])).toMatchObject({ _nay: { name: "read_only" } });
});

describe("folder metadata", () => {
	async function seed_folder_metadata() {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Folder Metadata Owner",
		});
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const folder = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			...scope,
			path: "/folder-metadata",
		});
		const nested = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			...scope,
			path: "/folder-metadata/nested",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		if (nested._nay) throw new Error(nested._nay.message);
		return { t, db, asOwner, scope, folderId: folder._yay.nodeId, nestedId: nested._yay.nodeId };
	}

	test("set_entries and update_entries_by_path keep an editable committed folder map", async () => {
		const { t, db, asOwner, scope, folderId } = await seed_folder_metadata();
		expect(
			await asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: folderId,
				metadataYaml: "plugin-name: chitchat\npriority: 3\nreviewed: false\n",
			}),
		).toEqual({ _yay: null });
		const updated = await t.mutation(internal.files_metadata.update_entries_by_path, {
			...scope,
			path: "/folder-metadata",
			set: [
				{ key: "plugin-name", value: "council" },
				{ key: "source", value: "member" },
			],
			remove: ["priority"],
		});
		if (updated._nay) throw new Error(updated._nay.message);
		expect(updated._yay.entries).toEqual([
			{ key: "plugin-name", value: "council" },
			{ key: "reviewed", value: false },
			{ key: "source", value: "member" },
		]);
		expect(
			await asOwner.query(api.files_metadata.get_entries, {
				membershipId: db.membershipId,
				fileNodeId: folderId,
			}),
		).toEqual(updated._yay.entries);
		const read = await t.query(internal.files_metadata.get_index_values_by_path, {
			...scope,
			path: "/folder-metadata",
			overlayUserId: db.userId,
		});
		expect(read).toMatchObject({
			target: { kind: "saved", id: folderId },
			path: "/folder-metadata",
			sourceKind: "committed",
		});
		expect(read?.fields.slice().sort()).toEqual(["metadata.plugin-name", "metadata.reviewed", "metadata.source"]);
		expect(read?.values.map((value) => value.valueKind).sort()).toEqual(["boolean", "string", "string"]);

		expect(
			await asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: folderId,
				metadataYaml: "",
			}),
		).toEqual({ _yay: null });
		expect(
			await t.query(internal.files_metadata.get_index_values_by_path, {
				...scope,
				path: "/folder-metadata",
				overlayUserId: db.userId,
			}),
		).toMatchObject({ fields: [], values: [], sourceKind: "committed" });
	});

	test.each([
		{ lockKind: "direct", expectRefusal: true },
		{ lockKind: "parent", expectRefusal: false },
	] as const)(
		"both folder write doors treat a $lockKind lock on nested metadata",
		async ({ lockKind, expectRefusal }) => {
			const { t, db, asOwner, scope, folderId, nestedId } = await seed_folder_metadata();
			const lockId = lockKind === "direct" ? nestedId : folderId;
			expect(
				(
					await asOwner.mutation(api.files_nodes.set_node_write_policy, {
						writePolicy: { mode: "read_only" },
						membershipId: db.membershipId,
						nodeId: lockId,
					})
				)._nay,
			).toBeUndefined();

			const publicWrite = await asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: nestedId,
				metadataYaml: "status: blocked",
			});
			const internalWrite = await t.mutation(internal.files_metadata.update_entries_by_path, {
				...scope,
				path: "/folder-metadata/nested",
				set: [{ key: "status", value: "blocked" }],
				remove: [],
			});

			// A parent lock never blocks nested metadata. Only a lock on the nested folder itself refuses.
			if (expectRefusal) {
				expect(publicWrite).toMatchObject({ _nay: { name: "read_only" } });
				expect(internalWrite).toMatchObject({ _nay: { name: "read_only" } });
				expect(
					await asOwner.query(api.files_metadata.get_entries, {
						membershipId: db.membershipId,
						fileNodeId: nestedId,
					}),
				).toEqual([]);
				expect(
					(
						await asOwner.mutation(api.files_nodes.set_node_write_policy, {
							writePolicy: null,
							membershipId: db.membershipId,
							nodeId: lockId,
						})
					)._nay,
				).toBeUndefined();
				expect(
					(
						await t.mutation(internal.files_metadata.update_entries_by_path, {
							...scope,
							path: "/folder-metadata/nested",
							set: [{ key: "status", value: "open" }],
							remove: [],
						})
					)._nay,
				).toBeUndefined();
				expect(
					await asOwner.query(api.files_metadata.get_entries, {
						membershipId: db.membershipId,
						fileNodeId: nestedId,
					}),
				).toEqual([{ key: "status", value: "open" }]);
				return;
			}

			expect(publicWrite).toEqual({ _yay: null });
			expect(internalWrite._nay).toBeUndefined();
			expect(
				await asOwner.query(api.files_metadata.get_entries, {
					membershipId: db.membershipId,
					fileNodeId: nestedId,
				}),
			).toEqual([{ key: "status", value: "blocked" }]);
		},
	);

	test("rename, move, archive and restore update folder maps and nested index scopes", async () => {
		const { t, db, asOwner, scope, folderId, nestedId } = await seed_folder_metadata();
		for (const nodeId of [folderId, nestedId]) {
			expect(
				await asOwner.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
					metadataYaml: "folder-key: shared",
				}),
			).toEqual({ _yay: null });
		}
		const destination = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			...scope,
			path: "/destination",
		});
		if (destination._nay) throw new Error(destination._nay.message);

		const search = (folderPath?: string) =>
			test_meta_search(t, {
				...scope,
				plan: { op: "eq", fieldPath: "metadata.folder-key", value: "shared" },
				folderPath,
			});

		const assertScope = async (paths: string[], archived: boolean) => {
			const docs = await t.run(async (ctx) =>
				(await ctx.db.query("files_metadata_docs").collect()).filter(
					(doc) => doc.sourceKind === "committed" && (doc.fileNodeId === folderId || doc.fileNodeId === nestedId),
				),
			);
			expect(docs).toHaveLength(4);
			expect([...new Set(docs.map((doc) => doc.path))].sort()).toEqual(paths.slice().sort());
			for (const doc of docs) {
				expect(doc.treePath).toBe(doc.path + "/");
				expect(doc.archiveOperationId !== undefined).toBe(archived);
			}
			expect((await search()).items.map((item) => item.path).sort()).toEqual(archived ? [] : paths.slice().sort());
		};

		expect(
			(
				await test_rename_node(t, asOwner, {
					membershipId: db.membershipId,
					nodeId: nestedId,
					path: "inner",
				})
			)._nay,
		).toBeUndefined();
		await assertScope(["/folder-metadata", "/folder-metadata/inner"], false);

		expect(
			(
				await test_rename_node(t, asOwner, {
					membershipId: db.membershipId,
					nodeId: folderId,
					path: "renamed",
				})
			)._nay,
		).toBeUndefined();
		await assertScope(["/renamed", "/renamed/inner"], false);
		expect((await search("/folder-metadata")).items).toEqual([]);

		expect(
			(
				await test_move_nodes(t, asOwner, {
					membershipId: db.membershipId,
					itemIds: [folderId],
					targetParentId: destination._yay.nodeId,
				})
			)._nay,
		).toBeUndefined();
		await assertScope(["/destination/renamed", "/destination/renamed/inner"], false);
		expect((await search("/renamed")).items).toEqual([]);
		expect((await search("/destination/renamed")).items).toHaveLength(2);

		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: db.userId });
		expect(
			(
				await asOwner.mutation(api.files_nodes.archive_nodes, {
					membershipId: db.membershipId,
					nodeIds: [folderId],
				})
			)._nay,
		).toBeUndefined();
		await test_finish_saved_scope_jobs(t);
		await assertScope(["/destination/renamed", "/destination/renamed/inner"], true);
		await test_compact_metadata_catalog(t);
		expect((
			await asOwner.query(api.files_metadata.list_search_fields, {
				membershipId: db.membershipId,
				prefix: "",
				paginationOpts: { numItems: 50, cursor: null },
			})
		).page).toEqual([]);
		expect(
			(
				await asOwner.query(api.files_metadata.list_search_values, {
					membershipId: db.membershipId,
					fieldPath: "metadata.folder-key",
					prefix: "",
					paginationOpts: { numItems: 50, cursor: null },
				})
			).page,
		).toEqual([]);

		expect(
			(
				await test_rename_node(t, asOwner, {
					membershipId: db.membershipId,
					nodeId: destination._yay.nodeId,
					path: "restored-parent",
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await asOwner.mutation(api.files_nodes.unarchive_nodes, {
					membershipId: db.membershipId,
					nodeIds: [folderId],
				})
			)._nay,
		).toBeUndefined();
		await test_finish_saved_scope_jobs(t);
		await assertScope(["/restored-parent/renamed", "/restored-parent/renamed/inner"], false);
		expect((await search("/destination")).items).toEqual([]);
		await test_compact_metadata_catalog(t);
		expect((
			await asOwner.query(api.files_metadata.list_search_fields, {
				membershipId: db.membershipId,
				prefix: "",
				paginationOpts: { numItems: 50, cursor: null },
			})
		).page).toEqual([
			{ fieldPath: "metadata.folder-key", valueKinds: ["string"] },
		]);
		expect(
			(
				await asOwner.query(api.files_metadata.list_search_values, {
					membershipId: db.membershipId,
					fieldPath: "metadata.folder-key",
					prefix: "",
					paginationOpts: { numItems: 50, cursor: null },
				})
			).page,
		).toEqual(["shared"]);
	});

	test("a pending folder move reads and updates committed maps through each user's visible path", async () => {
		const { t, db, asOwner, scope, folderId, nestedId } = await seed_folder_metadata();
		for (const nodeId of [folderId, nestedId]) {
			expect(
				await asOwner.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
					metadataYaml: "status: open",
				}),
			).toEqual({ _yay: null });
		}
		const otherUserId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_folder_metadata_reader" });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return userId;
		});
		expect(
			(
				await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...scope,
					target: { kind: "saved", id: folderId },
					destParent: { kind: "root" },
					destName: "pending-folder",
				})
			)._nay,
		).toBeUndefined();

		const read = (path: string, userId: Id<"users">) =>
			t.query(internal.files_metadata.get_index_values_by_path, {
				...scope,
				userId,
				path,
				overlayUserId: userId,
			});
		for (const suffix of ["", "/nested"]) {
			expect(await read("/folder-metadata" + suffix, db.userId)).toBeNull();
			expect(await read("/pending-folder" + suffix, db.userId)).toMatchObject({ sourceKind: "committed" });
			expect(await read("/folder-metadata" + suffix, otherUserId)).toMatchObject({ sourceKind: "committed" });
			expect(await read("/pending-folder" + suffix, otherUserId)).toBeNull();
		}
		expect(
			(
				await t.mutation(internal.files_metadata.update_entries_by_path, {
					...scope,
					path: "/pending-folder/nested",
					set: [{ key: "status", value: "changed" }],
					remove: [],
				})
			)._nay,
		).toBeUndefined();
		expect((await read("/folder-metadata/nested", otherUserId))?.values).toMatchObject([
			{ fieldPath: "metadata.status", stringValue: "changed" },
		]);
		expect(
			await t.mutation(internal.files_metadata.update_entries_by_path, {
				...scope,
				path: "/folder-metadata/nested",
				set: [{ key: "status", value: "wrong path" }],
				remove: [],
			}),
		).toMatchObject({ _nay: { message: "Not found" } });

		const pendingMove = await asOwner.query(api.files_pending_updates.get_file_pending_update, {
			membershipId: db.membershipId,
			target: { kind: "saved", id: folderId },
		});
		if (!pendingMove) throw new Error("Expected the folder move proposal");
		expect(
			(
				await test_apply_file_pending_move(asOwner, {
					membershipId: db.membershipId,
					target: { kind: "saved", id: folderId },
					pendingUpdateId: pendingMove._id,
					reviewedRevision: pendingMove.revision,
				})
			)._nay,
		).toBeUndefined();
		for (const [nodeId, path] of [
			[folderId, "/pending-folder"],
			[nestedId, "/pending-folder/nested"],
		] as const) {
			const docs = await t.run(async (ctx) =>
				(await ctx.db.query("files_metadata_docs").collect()).filter(
					(doc) => doc.sourceKind === "committed" && doc.fileNodeId === nodeId,
				),
			);
			expect(docs).toHaveLength(2);
			for (const doc of docs) expect(doc).toMatchObject({ path, treePath: path + "/", sourceKind: "committed" });
		}
		const search = async (folderPath: string) =>
			new Set(
				(
					await asOwner.query(api.files_nodes.search_saved, {
						membershipId: db.membershipId,
						clause: { kind: "metadata", plan: { op: "exists", fieldPath: "metadata.status" } },
						folderPath,
						paginationOpts: { numItems: 50, cursor: null },
					})
				).page.map((row) => (row.kind === "problem" ? row.message : row.nodeId)),
			);
		expect(await search("/folder-metadata")).toEqual(new Set(["Folder not found"]));
		expect(await search("/pending-folder")).toEqual(new Set([folderId, nestedId]));
	});
});

describe("folder table sort fields", () => {
	async function seed_sort_fields() {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Sort Fields Owner",
			email: "sort-fields-owner@example.com",
		});
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const create_folder = async (path: string) => {
			const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path });
			if (created._nay) throw new Error(created._nay.message);
			return created._yay.nodeId;
		};
		const set_metadata = async (nodeId: Id<"files_nodes">, metadataYaml: string) => {
			const saved = await asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: nodeId,
				metadataYaml,
			});
			if (saved._nay) throw new Error(saved._nay.message);
		};
		return { t, db, asOwner, create_folder, set_metadata };
	}

	async function read_sort_fields(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
		return await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!node) throw new Error("Expected the node");
			const docs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q.eq("organizationId", node.organizationId).eq("workspaceId", node.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			return {
				node: {
					sortName: node.sortName,
					contentByteSize: node.contentByteSize,
					isRestrictedScopeRoot: node.isRestrictedScopeRoot,
				},
				fields: docs.flatMap((doc) =>
					doc.sourceKind === "committed" && doc.docKind === "field"
						? [
								{
									fieldPath: doc.fieldPath,
									archiveOperationId: doc.archiveOperationId,
									parentId: doc.parentId,
									nodeKind: doc.nodeKind,
									isRestrictedScopeRoot: doc.isRestrictedScopeRoot,
									name: doc.name,
									sortName: doc.sortName,
									sortValue: doc.sortValue,
									sortDisplayValue: doc.sortDisplayValue,
								},
							]
						: [],
				),
				// Value docs never carry the sort fields.
				valueDocsWithSortFields: docs.filter(
					(doc) => doc.docKind === "value" && "parentId" in doc && doc.parentId !== undefined,
				).length,
			};
		});
	}

	test("a new folder and its metadata carry the sort fields", async () => {
		const { t, create_folder, set_metadata } = await seed_sort_fields();
		const parentId = await create_folder("/Sort Parent");
		const folderId = await create_folder("/Sort Parent/Café 10");
		await set_metadata(folderId, "status: Open\ncount: 12\n");

		const read = await read_sort_fields(t, folderId);
		expect(read.node).toEqual({ sortName: "cafe 0210", contentByteSize: null, isRestrictedScopeRoot: false });
		const shared = {
			parentId,
			nodeKind: "folder",
			isRestrictedScopeRoot: false,
			name: "Café 10",
			sortName: "cafe 0210",
		};
		expect(read.fields).toEqual(
			expect.arrayContaining([
				{
					...shared,
					fieldPath: "metadata.status",
					archiveOperationId: undefined,
					sortValue: "open",
					sortDisplayValue: "Open",
				},
				{
					...shared,
					fieldPath: "metadata.count",
					archiveOperationId: undefined,
					sortValue: "0212",
					sortDisplayValue: 12,
				},
			]),
		);
		expect(read.fields).toHaveLength(2);
		expect(read.valueDocsWithSortFields).toBe(0);
	});

	test("a rename into new folders and a folder move update the node and its field docs", async () => {
		const { t, db, asOwner, create_folder, set_metadata } = await seed_sort_fields();
		await create_folder("/sort-parent");
		const leafId = await create_folder("/sort-parent/leaf");
		await set_metadata(leafId, "status: Open\n");

		// A rename path starts at the node's parent. This one creates two planned folders, and the leaf
		// gets the inner one's id only when the plan is applied.
		const renamed = await test_rename_node(t, asOwner, {
			membershipId: db.membershipId,
			nodeId: leafId,
			path: "new/deep/zeta",
		});
		expect(renamed._nay).toBeUndefined();
		const { newId, deepId } = await t.run(async (ctx) => {
			const nodes = await ctx.db.query("files_nodes").collect();
			return {
				newId: nodes.find((node) => node.path === "/sort-parent/new")!._id,
				deepId: nodes.find((node) => node.path === "/sort-parent/new/deep")!._id,
			};
		});
		expect((await read_sort_fields(t, deepId)).node).toEqual({
			sortName: "deep",
			contentByteSize: null,
			isRestrictedScopeRoot: false,
		});
		const renamedRead = await read_sort_fields(t, leafId);
		expect(renamedRead.node.sortName).toBe("zeta");
		expect(renamedRead.fields).toEqual([
			expect.objectContaining({ fieldPath: "metadata.status", parentId: deepId, name: "zeta", sortName: "zeta" }),
		]);

		// Moving a folder with children changes the parent of the moved folder only.
		await set_metadata(newId, "rank: 1\n");
		const moved = await test_move_nodes(t, asOwner, {
			membershipId: db.membershipId,
			itemIds: [newId],
			targetParentId: files_ROOT_ID,
		});
		expect(moved._nay).toBeUndefined();
		expect((await read_sort_fields(t, newId)).fields).toEqual([
			expect.objectContaining({ fieldPath: "metadata.rank", parentId: files_ROOT_ID, name: "new" }),
		]);
		expect((await read_sort_fields(t, leafId)).fields).toEqual([
			expect.objectContaining({ fieldPath: "metadata.status", parentId: deepId, name: "zeta" }),
		]);
	});

	test("archive keeps the field docs, and a restore to the root moves their parent", async () => {
		const { t, db, asOwner, create_folder, set_metadata } = await seed_sort_fields();
		const parentId = await create_folder("/archive-parent");
		const childId = await create_folder("/archive-parent/child");
		await set_metadata(childId, "status: Open\n");

		for (const nodeId of [childId, parentId]) {
			const archived = await asOwner.mutation(api.files_nodes.archive_nodes, {
				membershipId: db.membershipId,
				nodeIds: [nodeId],
			});
			expect(archived._nay).toBeUndefined();
		}
		await test_finish_saved_scope_jobs(t);
		const archivedRead = await read_sort_fields(t, childId);
		expect(archivedRead.fields).toEqual([
			expect.objectContaining({ parentId, archiveOperationId: expect.any(String), sortValue: "open" }),
		]);

		// The parent stays archived, so the child comes back at the root.
		const restored = await asOwner.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [childId],
		});
		expect(restored._nay).toBeUndefined();
		await test_finish_saved_scope_jobs(t);
		const restoredRead = await read_sort_fields(t, childId);
		expect(restoredRead.fields).toHaveLength(1);
		expect(restoredRead.fields[0]).toMatchObject({ parentId: files_ROOT_ID, sortValue: "open" });
		expect(restoredRead.fields[0]?.archiveOperationId).toBeUndefined();
	});

	test("restrict and unrestrict set the flag on the node and on its field docs, archived ones too", async () => {
		const { t, db, asOwner, create_folder, set_metadata } = await seed_sort_fields();
		const folderId = await create_folder("/restricted");
		await set_metadata(folderId, "status: Open\n");

		const restricted = await asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: db.membershipId,
			nodeId: folderId,
		});
		expect(restricted._nay).toBeUndefined();
		const restrictedRead = await read_sort_fields(t, folderId);
		expect(restrictedRead.node.isRestrictedScopeRoot).toBe(true);
		expect(restrictedRead.fields).toEqual([expect.objectContaining({ isRestrictedScopeRoot: true })]);
		expect(restrictedRead.valueDocsWithSortFields).toBe(0);

		const archived = await asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [folderId],
		});
		expect(archived._nay).toBeUndefined();
		await test_finish_saved_scope_jobs(t);
		const unrestricted = await asOwner.mutation(api.files_sharing.unrestrict_node, {
			membershipId: db.membershipId,
			nodeId: folderId,
		});
		expect(unrestricted._nay).toBeUndefined();
		const unrestrictedRead = await read_sort_fields(t, folderId);
		expect(unrestrictedRead.node.isRestrictedScopeRoot).toBe(false);
		expect(unrestrictedRead.fields).toEqual([
			expect.objectContaining({ archiveOperationId: expect.any(String), isRestrictedScopeRoot: false }),
		]);
	});

	test("a frontmatter save sorts by the first list item and leaves a map parent without a value", async () => {
		const { t, db, asOwner } = await seed_sort_fields();
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		test_setup_r2_capture();
		const markdown = "---\ntags: [Zeta, alpha]\ndue: 2026-09-04\nmeta:\n  size: 7\n---\n# Note\n";
		const nodeId = await test_materialize_markdown_file({ t, asUser: asOwner, db, path: "/note-10.md", markdown });

		const read = await read_sort_fields(t, nodeId);
		expect(read.node).toMatchObject({ sortName: "note-0210.md", isRestrictedScopeRoot: false });
		const byField = new Map(read.fields.map((field) => [field.fieldPath, field]));
		expect(byField.get("frontmatter.tags")).toMatchObject({
			parentId: files_ROOT_ID,
			nodeKind: "file",
			name: "note-10.md",
			sortValue: "zeta",
			sortDisplayValue: "Zeta",
		});
		expect(byField.get("frontmatter.due")).toMatchObject({
			sortValue: "042026-019-014",
			sortDisplayValue: "2026-09-04",
		});
		expect(byField.get("frontmatter.meta.size")).toMatchObject({ sortValue: "017", sortDisplayValue: 7 });
		// `t.run` drops undefined fields from its result, so check that the keys are gone.
		expect(byField.get("frontmatter.meta")).not.toHaveProperty("sortValue");
		expect(byField.get("frontmatter.meta")).not.toHaveProperty("sortDisplayValue");
	});

	test("an upload starts with the declared size, and the R2 event corrects it", async () => {
		const { t, db, asOwner } = await seed_sort_fields();

		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "scan.png",
			contentType: "image/png",
			size: 4096,
		});
		if (upload._nay) throw new Error(upload._nay.message);
		expect((await read_sort_fields(t, upload._yay.nodeId)).node.contentByteSize).toBe(4096);
		await t.mutation(internal.r2.process_uploaded_asset_event, {
			assetId: upload._yay.assetId,
			r2Key: r2_create_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: upload._yay.assetId,
			}),
			size: 2048,
			etag: "etag-sort-size",
			eventId: "sort-size-event",
		});
		expect((await read_sort_fields(t, upload._yay.nodeId)).node.contentByteSize).toBe(2048);
	});

	test("a materialization sets contentByteSize to the new version snapshot size", async () => {
		const { t, db, asOwner } = await seed_sort_fields();
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		test_setup_r2_capture();
		const markdown = "# Longer text than before\n";
		const nodeId = await test_materialize_markdown_file({ t, asUser: asOwner, db, path: "/sized.md", markdown });
		const sized = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const asset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			return { contentByteSize: node?.contentByteSize, assetSize: asset?.size };
		});
		// The saved text is the editor's Markdown, so compare with the asset, not with the input text.
		expect(sized.contentByteSize).toBeGreaterThan(0);
		expect(sized.contentByteSize).toBe(sized.assetSize);
	});
});

describe("list_tree_children_sorted", () => {
	test("every built-in field sorts both ways, folders first and missing values last", async () => {
		const { read_table, insert_child } = await seed_folder_table();
		await insert_child({ name: "beta", kind: "folder", updatedAt: 2 });
		await insert_child({ name: "alpha", kind: "folder", updatedAt: 1 });
		await insert_child({ name: "b.md", kind: "file", updatedAt: 3, lowercaseExtension: "md", contentByteSize: 30 });
		await insert_child({ name: "a.txt", kind: "file", updatedAt: 5, lowercaseExtension: "txt", contentByteSize: 10 });
		await insert_child({ name: "file10.md", kind: "file", updatedAt: 4, lowercaseExtension: "md" });
		await insert_child({ name: "file2.md", kind: "file", updatedAt: 1, lowercaseExtension: "md", contentByteSize: 20 });
		await insert_child({ name: "readme", kind: "file", updatedAt: 2, contentByteSize: 5 });

		expect(await read_table({ field: "name", direction: "asc" })).toEqual([
			"alpha",
			"beta",
			"a.txt",
			"b.md",
			"file2.md",
			"file10.md",
			"readme",
		]);
		expect(await read_table({ field: "name", direction: "desc" })).toEqual([
			"beta",
			"alpha",
			"readme",
			"file10.md",
			"file2.md",
			"b.md",
			"a.txt",
		]);
		expect(await read_table({ field: "created", direction: "asc" })).toEqual([
			"beta",
			"alpha",
			"b.md",
			"a.txt",
			"file10.md",
			"file2.md",
			"readme",
		]);
		expect(await read_table({ field: "created", direction: "desc" })).toEqual([
			"alpha",
			"beta",
			"readme",
			"file2.md",
			"file10.md",
			"a.txt",
			"b.md",
		]);
		expect(await read_table({ field: "updated", direction: "asc" })).toEqual([
			"alpha",
			"beta",
			"file2.md",
			"readme",
			"b.md",
			"file10.md",
			"a.txt",
		]);
		expect(await read_table({ field: "updated", direction: "desc" })).toEqual([
			"beta",
			"alpha",
			"a.txt",
			"file10.md",
			"b.md",
			"readme",
			"file2.md",
		]);
		// Folders and files without an extension have no file.extension, so they sort by name after the others.
		expect(await read_table({ field: "extension", direction: "asc" })).toEqual([
			"alpha",
			"beta",
			"b.md",
			"file2.md",
			"file10.md",
			"a.txt",
			"readme",
		]);
		expect(await read_table({ field: "extension", direction: "desc" })).toEqual([
			"alpha",
			"beta",
			"a.txt",
			"file10.md",
			"file2.md",
			"b.md",
			"readme",
		]);
		// Folders have no size, so they stay by name in both directions.
		expect(await read_table({ field: "size", direction: "asc" })).toEqual([
			"alpha",
			"beta",
			"readme",
			"a.txt",
			"file2.md",
			"b.md",
			"file10.md",
		]);
		expect(await read_table({ field: "size", direction: "desc" })).toEqual([
			"alpha",
			"beta",
			"b.md",
			"file2.md",
			"a.txt",
			"readme",
			"file10.md",
		]);
	});

	test("a metadata key sorts its values both ways and leaves out children without a value", async () => {
		const { t, db, asOwner, read_page, read_table, insert_child } = await seed_folder_table();
		const ids = new Map<string, Id<"files_nodes">>();
		for (const [name, kind] of [
			["beta", "folder"],
			["alpha", "folder"],
			["b.md", "file"],
			["a.txt", "file"],
			["file10.md", "file"],
			["readme", "file"],
			["map.md", "file"],
		] as const) {
			ids.set(name, await insert_child({ name, kind, updatedAt: 1 }));
		}
		for (const [name, status] of [
			["alpha", "x"],
			["b.md", "Closed"],
			["a.txt", "open"],
			["readme", "done"],
			["map.md", "zzz"],
		] as const) {
			const saved = await asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: ids.get(name)!,
				metadataYaml: `status: ${status}\n`,
			});
			expect(saved._nay).toBeUndefined();
		}
		// A field doc with no value, like a frontmatter map, counts as missing.
		await t.run(async (ctx) => {
			const fieldDoc = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", ids.get("map.md")!)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined)
						.eq("fieldPath", "metadata.status"),
				)
				.filter((q) => q.eq(q.field("docKind"), "field"))
				.unique();
			await ctx.db.patch("files_metadata_docs", fieldDoc!._id, { sortValue: undefined, sortDisplayValue: undefined });
		});

		expect(await read_table({ field: "metadata.status", direction: "asc" })).toEqual([
			"alpha",
			"b.md",
			"readme",
			"a.txt",
		]);
		expect(await read_table({ field: "metadata.status", direction: "desc" })).toEqual([
			"alpha",
			"a.txt",
			"readme",
			"b.md",
		]);
		// A metadata sort has no `missing` segment.
		expect(
			await read_page({
				kind: "file",
				sort: { field: "metadata.status", direction: "asc" },
				segment: "missing",
				paginationOpts: { numItems: 10, cursor: null },
			}),
		).toEqual({ page: [], isDone: true, continueCursor: "" });

		const first = await read_page({
			kind: "file",
			sort: { field: "metadata.status", direction: "asc" },
			paginationOpts: { numItems: 1, cursor: null },
		});
		expect(first.page).toEqual([
			expect.objectContaining({
				name: "b.md",
				sortKey: { parts: [["closed", "b.md", "b.md"]], nameKey: ["b.md", "b.md"] },
			}),
		]);
		expect(first.page[0]).not.toHaveProperty("sortFieldValue");
	});

	test("a restored row's metadata cells show no value until its saved scope job runs", async () => {
		vi.useFakeTimers();
		const { t, db, asOwner, parentId, insert_child, set_metadata } = await seed_folder_table();
		const fileId = await insert_child({ name: "a.md", kind: "file", updatedAt: 1 });
		await set_metadata([[fileId, [{ key: "status", value: "ready" }]]]);
		const target = { kind: "saved" as const, id: fileId };
		const cells = () =>
			asOwner.query(api.files_metadata.get_field_values, {
				membershipId: db.membershipId,
				target,
				fields: ["metadata.status"],
				afterField: null,
			});
		const fields = async () =>
			(
				await asOwner.query(api.files_metadata.list_node_fields, {
					membershipId: db.membershipId,
					target,
					cursor: null,
				})
			)?.fields;
		// The calls an archive run and a restore run make (`files_archive_runs.ts`).
		await t.run(async (ctx) =>
			files_nodes_db_archive_node(ctx, {
				node: (await ctx.db.get("files_nodes", fileId))!,
				archiveOperationId: "op-1",
				updatedBy: db.userId,
				now: Date.now(),
			}),
		);
		await test_finish_saved_scope_jobs(t);
		await t.run(async (ctx) =>
			files_nodes_db_restore_node(ctx, {
				node: (await ctx.db.get("files_nodes", fileId))!,
				parent: await ctx.db.get("files_nodes", parentId),
				name: "a.md",
				updatedBy: db.userId,
				now: Date.now(),
			}),
		);

		await expect(cells(), "a restored row shows no value until the job runs").resolves.toMatchObject({
			values: [{ field: "metadata.status", value: null }],
		});
		await expect(fields(), "a restored row lists no field until the job runs").resolves.toEqual([]);
		await test_finish_saved_scope_jobs(t);
		expect(await cells()).toMatchObject({ values: [{ field: "metadata.status", value: "ready" }] });
		expect(await fields()).toEqual(["metadata.status"]);

		// With no job, a stale archive id is a bug and still fails loudly.
		await t.run(async (ctx) => {
			const fieldDoc = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", fileId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined)
						.eq("fieldPath", "metadata.status"),
				)
				.filter((q) => q.eq(q.field("docKind"), "field"))
				.unique();
			await ctx.db.patch("files_metadata_docs", fieldDoc!._id, { archiveOperationId: "op-2" });
		});
		await expect(cells()).rejects.toThrow("metadataDoc source is mismatched");
	});

	test("a row that Archive and a Keep both Restore renamed in its folder leaves a metadata sort until its saved scope job runs", async () => {
		vi.useFakeTimers();
		const { t, db, parentId, insert_children, set_metadata, read_page } = await seed_folder_table();
		const [fileId, keptId] = await insert_children([
			{ name: "a.md", kind: "file", updatedAt: 1 },
			{ name: "kept.md", kind: "file", updatedAt: 1 },
		]);
		await set_metadata([
			[fileId!, [{ key: "status", value: "ready" }]],
			[keptId!, [{ key: "status", value: "ready" }]],
		]);
		const names = async () =>
			(
				await read_page({
					kind: "file",
					sort: { field: "metadata.status", direction: "asc" },
					paginationOpts: { numItems: 10, cursor: null },
				})
			).page.map((row) => row.name);
		// The calls an archive run and a restore run make (`files_archive_runs.ts`). Keep both gives
		// a new name in the same folder before the Archive's job ran.
		await t.run(async (ctx) =>
			files_nodes_db_archive_node(ctx, {
				node: (await ctx.db.get("files_nodes", fileId!))!,
				archiveOperationId: "op-1",
				updatedBy: db.userId,
				now: Date.now(),
			}),
		);
		await t.run(async (ctx) =>
			files_nodes_db_restore_node(ctx, {
				node: (await ctx.db.get("files_nodes", fileId!))!,
				parent: await ctx.db.get("files_nodes", parentId),
				name: "a (1).md",
				updatedBy: db.userId,
				now: Date.now(),
			}),
		);

		await expect(names(), "the renamed row is left out until the job runs").resolves.toEqual(["kept.md"]);
		await test_finish_saved_scope_jobs(t);
		expect(await names()).toEqual(["a (1).md", "kept.md"]);

		// With no job, a stale name is a bug and still fails loudly.
		await t.run((ctx) => ctx.db.patch("files_nodes", fileId!, { name: "a (2).md", sortName: "a (2).md" }));
		await expect(names()).rejects.toThrow("fieldDoc sort fields are mismatched");
	});

	test("a page over the byte limit asks for a split, and the halves give every row once", async () => {
		const { t, db, insert_child, read_page } = await seed_folder_table({ transactionLimits: true });
		const names = Array.from({ length: 8 }, (_, index) => `large-${index}.md`);
		const value = "x".repeat(800_000);
		for (const name of names) {
			const nodeId = await insert_child({ name, kind: "file", updatedAt: 1 });
			await t.run((ctx) =>
				files_metadata_db_insert_committed(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					nodeId,
					markdownContent: `---\nvalue: ${value}\n---\n`,
				}),
			);
		}
		const sort = { field: "frontmatter.value", direction: "asc" as const };
		// New index docs cut long values, so the same rows now fit in one page.
		expect(
			(await read_page({ kind: "file", sort, paginationOpts: { numItems: 50, cursor: null } })).page.map(
				(row) => row.name,
			),
		).toEqual(names);
		// Index docs written before the cut can still hold the whole value. Their page must still split.
		await t.run(async (ctx) => {
			for (const doc of await ctx.db.query("files_metadata_docs").collect())
				if (doc.docKind === "field" && doc.fieldPath === "frontmatter.value")
					await ctx.db.patch("files_metadata_docs", doc._id, { sortDisplayValue: value });
		});

		// Read a range like `usePaginatedQuery`: split it until each half fits.
		const read_range = async (cursor: string | null, endCursor: string, depth = 0): Promise<string[]> => {
			// A split that does not shrink the range would recurse forever, past the test timeout.
			if (depth > 10) throw new Error("The range did not stop splitting");
			const result = await read_page({ kind: "file", sort, paginationOpts: { numItems: 50, cursor, endCursor } });
			if (result.pageStatus !== "SplitRequired") return result.page.map((row) => row.name);
			expect(result.page).toEqual([]);
			return [
				...(await read_range(cursor, result.splitCursor!, depth + 1)),
				...(await read_range(result.splitCursor!, endCursor, depth + 1)),
			];
		};

		const first = await read_page({ kind: "file", sort, paginationOpts: { numItems: 50, cursor: null } });
		expect(first).toMatchObject({ page: [], isDone: false, pageStatus: "SplitRequired" });
		expect(first.splitCursor).toEqual(expect.any(String));
		const rest = await read_page({
			kind: "file",
			sort,
			paginationOpts: { numItems: 50, cursor: first.continueCursor },
		});
		expect(rest.isDone).toBe(true);
		expect([...(await read_range(null, first.continueCursor)), ...rest.page.map((row) => row.name)]).toEqual(names);
	});

	test("a member reads only the open stream, and the owner merges in the restricted one", async () => {
		const { t, db, asOwner, read_page, read_table, walk, insert_child, parentId } = await seed_folder_table();
		for (const name of ["a", "b", "c", "d"]) {
			await insert_child({ name, kind: "folder", updatedAt: 1 });
		}
		const hiddenId = await t.run(
			async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).find((node) => node.parentId === parentId && node.name === "b")!
					._id,
		);
		expect(
			await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: hiddenId }),
		).toEqual({ _yay: null });

		const member = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "member-home" }));
		expect(
			await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userIdToAdd: member.userId,
			}),
		).toEqual({ _yay: null });
		const membershipId = await t.run(
			async (ctx) =>
				(await ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", db.workspaceId).eq("userId", member.userId))
					.first())!._id,
		);
		const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });

		for (const sort of [
			{ field: "name", direction: "asc" },
			{ field: "updated", direction: "desc" },
		] as const) {
			// `walk` checks that every page but the last holds exactly one row.
			const memberPages = await walk({ as: asMember, membershipId, kind: "folder", sort, numItems: 1 });
			expect(
				memberPages
					.flat()
					.map((row) => row.name)
					.sort(),
			).toEqual(["a", "c", "d"]);
			expect(
				await read_page({
					as: asMember,
					membershipId,
					kind: "folder",
					sort,
					restricted: true,
					paginationOpts: { numItems: 1, cursor: null },
				}),
			).toEqual({ page: [], isDone: true, continueCursor: "" });
			const ownerRestricted = await walk({ kind: "folder", sort, restricted: true, numItems: 1 });
			expect(ownerRestricted.flat().map((row) => row.name)).toEqual(["b"]);
		}
		expect(await read_table({ field: "name", direction: "asc" })).toEqual(["a", "b", "c", "d"]);
	});

	test("the owner merges 300 restricted children spread by name, with no repeat or gap", async () => {
		const { insert_children, read_table } = await seed_folder_table();
		const names = Array.from({ length: 600 }, (_, index) => `n-${String(index).padStart(3, "0")}.md`);
		await insert_children(
			names.map((name, index) => ({
				name,
				kind: "file" as const,
				updatedAt: index,
				lowercaseExtension: "md",
				contentByteSize: 600 - index,
				restricted: index % 2 === 1,
			})),
		);
		const reversed = [...names].reverse();

		expect(await read_table({ field: "name", direction: "asc" }, { numItems: 50 })).toEqual(names);
		expect(await read_table({ field: "name", direction: "desc" }, { numItems: 50 })).toEqual(reversed);
		expect(await read_table({ field: "updated", direction: "desc" }, { numItems: 50 })).toEqual(reversed);
		expect(await read_table({ field: "size", direction: "asc" }, { numItems: 50 })).toEqual(reversed);
		expect(await read_table({ field: "created", direction: "asc" }, { numItems: 50 })).toEqual(names);
	});

	// convex-test marks any page that reads more than `numItems` + 1 rows, so this proves the split
	// runs before any row read, not the guard number. A page asks for at most 200 rows, under every
	// guard, so only that mark can trip the split here. The cost test below checks the guard numbers.
	test.each([
		{ restricted: false, field: "metadata.status" },
		{ restricted: true, field: "metadata.status" },
		{ restricted: true, field: "name" },
	])(
		"a page whose end cursor holds more rows than it asks for asks for a split and reads no row ($field, restricted $restricted)",
		async ({ restricted, field }) => {
			const { t, insert_children, set_metadata, read_page } = await seed_folder_table();
			const names = Array.from({ length: 103 }, (_, index) => `n-${String(index).padStart(4, "0")}.md`);
			const ids = await insert_children(
				names.map((name) => ({ name, kind: "file" as const, updatedAt: 1, restricted })),
			);
			if (field !== "name") await set_metadata(ids.map((id) => [id, [{ key: "status", value: "open" }]]));
			const sort = { field, direction: "asc" as const };

			// Read 100 rows, then 2 more, to get the cursor right after row 102: one more than `numItems` + 1.
			const first = await read_page({
				kind: "file",
				sort,
				restricted,
				paginationOpts: { numItems: 100, cursor: null },
			});
			expect(first.page).toHaveLength(100);
			const endCursor = (
				await read_page({
					kind: "file",
					sort,
					restricted,
					paginationOpts: { numItems: 2, cursor: first.continueCursor },
				})
			).continueCursor;

			// A field doc whose node is gone makes a node read throw, and a SYSTEM author makes the tree
			// rows throw. So this page proves the guard runs before any row read.
			await t.run((ctx) =>
				field === "name"
					? ctx.db.patch("files_nodes", ids[101]!, { createdBy: users_SYSTEM_AUTHOR })
					: ctx.db.delete("files_nodes", ids[101]!),
			);
			expect(
				await read_page({ kind: "file", sort, restricted, paginationOpts: { numItems: 100, cursor: null, endCursor } }),
			).toEqual({
				page: [],
				isDone: false,
				continueCursor: endCursor,
				splitCursor: expect.any(String),
				pageStatus: "SplitRequired",
			});
			// A pinned page under the guard gives its rows.
			const small = await read_page({
				kind: "file",
				sort,
				restricted,
				paginationOpts: { numItems: 200, cursor: null, endCursor: first.continueCursor },
			});
			expect(small.page.map((row) => row.name)).toEqual(names.slice(0, 100));
		},
	);

	// Guard = floor(3,000 index ranges / index ranges read by the worst row). Each case fills one
	// stream with one kind of row, so the cost per row is that stream's worst row.
	test.each([
		{ restricted: false, field: "metadata.status", guard: 1800 },
		{ restricted: true, field: "metadata.status", guard: 700 },
		{ restricted: true, field: "name", guard: 1000 },
	])(
		"the $guard guard fits the measured reads of the worst row ($field, restricted $restricted)",
		async ({ restricted, field, guard }) => {
			const { insert_children, set_metadata, read_page_cost } = await seed_folder_table();
			const ids = await insert_children(
				Array.from({ length: 6 }, (_, index) => ({
					name: `n-${index}.md`,
					kind: "file" as const,
					updatedAt: 1,
					restricted,
				})),
			);
			if (field !== "name") await set_metadata(ids.map((id) => [id, [{ key: "status", value: "open" }]]));
			const sort = { field, direction: "asc" as const };

			// The page cost minus the cost of a one-row page is what the other rows read.
			const one = await read_page_cost({
				kind: "file",
				sort,
				restricted,
				paginationOpts: { numItems: 1, cursor: null },
			});
			const six = await read_page_cost({
				kind: "file",
				sort,
				restricted,
				paginationOpts: { numItems: 6, cursor: null },
			});
			expect([one.rows, six.rows]).toEqual([1, 6]);
			const perRow = (six.ranges - one.ranges) / 5;
			expect(perRow).toBeGreaterThan(0);
			expect(guard).toBeLessThanOrEqual(Math.floor(3000 / perRow));
		},
	);

	test("drafts and this user's draft moves and deletes do not change the table", async () => {
		const { t, db, parentId, read_table, insert_child } = await seed_folder_table();
		await insert_child({ name: "kept.md", kind: "file", updatedAt: 1 });
		const movedId = await insert_child({ name: "moved.md", kind: "file", updatedAt: 1 });
		const deletedId = await insert_child({ name: "deleted.md", kind: "file", updatedAt: 1 });
		const archivedId = await insert_child({ name: "archived.md", kind: "file", updatedAt: 1 });
		await t.run(async (ctx) => ctx.db.patch("files_nodes", archivedId, { archiveOperationId: "archive-1" }));
		const owner = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const elsewhere = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			...owner,
			path: "/elsewhere",
		});
		if (elsewhere._nay) throw new Error(elsewhere._nay.message);
		const before = await read_table({ field: "name", direction: "asc" });
		expect(before).toEqual(["deleted.md", "kept.md", "moved.md"]);

		await propose_move_for_test(t, { ...owner, nodeId: movedId, destParent: { kind: "root" }, destName: "moved.md" });
		await propose_move_for_test(t, {
			...owner,
			nodeId: elsewhere._yay.nodeId,
			destParent: { kind: "saved", id: parentId },
			destName: "moved-in",
		});
		expect(
			(
				await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					...owner,
					target: { kind: "saved", id: deletedId },
				})
			)._nay,
		).toBeUndefined();
		await t.run(async (ctx) => {
			const draft = await files_pending_nodes_db_create(ctx, {
				...owner,
				parent: { kind: "saved", id: parentId },
				name: "draft.md",
				kind: "file",
			});
			if (draft._nay) throw new Error(draft._nay.message);
		});

		expect(await read_table({ field: "name", direction: "asc" })).toEqual(before);
		// Every child has the same time, so this order is by name, backward.
		expect(await read_table({ field: "updated", direction: "desc" })).toEqual([...before].reverse());
	});

	test("refuses a folder the caller cannot read and a field that cannot be sorted", async () => {
		const { t, db, asOwner, parentId } = await seed_folder_table();
		const args = {
			membershipId: db.membershipId,
			parentId,
			kind: "file" as const,
			sort: [{ field: "name", direction: "asc" as const }],
			filter: null,
			namePrefix: null,
			restricted: false,
			segment: "value" as const,
			paginationOpts: { numItems: 10, cursor: null },
		};
		const refused = { page: [], isDone: true, continueCursor: "" };

		expect(
			await asOwner.query(api.files_tree.list_tree_children_sorted, {
				...args,
				sort: [{ field: "metadata.bad key", direction: "asc" }],
			}),
		).toEqual(refused);

		const other = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			await asOther.query(api.files_tree.list_tree_children_sorted, { ...args, membershipId: other.membershipId }),
		).toEqual(refused);
	});

	test("the table and the tree fail loudly on a stale restricted scope root flag", async () => {
		const { t, db, asOwner, parentId, insert_child, read_page } = await seed_folder_table();
		const nodeId = await insert_child({ name: "stale", kind: "folder", updatedAt: 1 });
		const archivedId = await insert_child({ name: "stale-archived", kind: "folder", updatedAt: 1 });
		// A direct patch skips the writer that keeps the flag in step.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
			await ctx.db.patch("files_nodes", archivedId, {
				archiveOperationId: "archive-operation-stale",
				restrictedScopeNodeId: archivedId,
			});
		});
		const read_tree = (archived: boolean) =>
			asOwner.query(api.files_tree.list_tree_children, {
				membershipId: db.membershipId,
				parentId,
				kind: "folder",
				archived,
				restricted: false,
				paginationOpts: { numItems: 10, cursor: null },
			});

		await expect(
			read_page({
				kind: "folder",
				sort: { field: "name", direction: "asc" },
				paginationOpts: { numItems: 10, cursor: null },
			}),
		).rejects.toThrow("files_nodes tree stream row scope is mismatched");
		await expect(read_tree(false)).rejects.toThrow("files_nodes tree stream row scope is mismatched");
		await expect(read_tree(true)).rejects.toThrow("files_nodes tree stream row scope is mismatched");
	});

	test("a metadata sort leaves out rows whose field docs still wait for the node's new scope", async () => {
		const { t, insert_children, set_metadata, read_page } = await seed_folder_table();
		const [archivedId, movedId, restrictedId, keptId] = await insert_children(
			["archived.md", "moved.md", "restricted.md", "kept.md"].map((name) => ({ name, kind: "file", updatedAt: 1 })),
		);
		await set_metadata(
			[archivedId!, movedId!, restrictedId!, keptId!].map((nodeId) => [nodeId, [{ key: "status", value: "ready" }]]),
		);
		const other = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		// Archive, Move and restrict change the node first. A background job patches the field docs later.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", archivedId!, { archiveOperationId: "archive-operation-lag" });
			await ctx.db.patch("files_nodes", movedId!, { parentId: keptId! });
			await ctx.db.patch("files_nodes", restrictedId!, {
				isRestrictedScopeRoot: true,
				restrictedScopeNodeId: restrictedId!,
			});
		});
		const read = () =>
			read_page({
				kind: "file",
				sort: { field: "metadata.status", direction: "asc" },
				paginationOpts: { numItems: 10, cursor: null },
			});

		expect((await read()).page.map((row) => row.name)).toEqual(["kept.md"]);

		// A node of another workspace is still a bug, also when its scope changed too.
		await t.run((ctx) =>
			ctx.db.patch("files_nodes", archivedId!, {
				organizationId: other.organizationId,
				workspaceId: other.workspaceId,
			}),
		);
		await expect(read()).rejects.toThrow("files_nodes tree stream row scope is mismatched");
	});
});

describe("list_tree_children_sorted filter", () => {
	test("each filter reads its rows in its own order, both ways, past 150 rows that do not match", async () => {
		const { insert_children, set_metadata, read_table, read_page_cost } = await seed_folder_table();
		const DAY = Date.UTC(2026, 8, 4);
		const HOUR = 60 * 60 * 1000;
		const fillers = (prefix: string) =>
			Array.from({ length: 75 }, (_, index) => ({
				name: `${prefix}-${String(index).padStart(2, "0")}.txt`,
				extension: "txt",
				size: null,
				updatedAt: DAY - (index + 1) * HOUR,
				entries: [],
			}));
		const fillerF = fillers("task-f");
		const fillerQ = fillers("task-q");
		// Three matches, with 150 rows between them by name that match none of the filters below.
		const children: Array<{
			name: string;
			extension: string | null;
			size: number | null;
			updatedAt: number;
			entries: files_metadata_Entry[];
		}> = [
			{
				name: "task-a.md",
				extension: "md",
				size: 30,
				updatedAt: DAY + 3 * HOUR,
				entries: [
					{ key: "status", value: "open" },
					{ key: "note", value: "alpha" },
				],
			},
			...fillerF,
			{
				name: "task-m.md",
				extension: "md",
				size: 20,
				updatedAt: DAY + HOUR,
				entries: [
					{ key: "status", value: "open" },
					{ key: "note", value: "alps" },
				],
			},
			...fillerQ,
			{
				name: "task-z.md",
				extension: "md",
				size: 25,
				updatedAt: DAY + 2 * HOUR,
				entries: [
					{ key: "status", value: "open" },
					{ key: "note", value: "beta" },
				],
			},
			{
				name: "notes",
				extension: null,
				size: null,
				updatedAt: DAY + 48 * HOUR,
				entries: [{ key: "status", value: "done" }],
			},
		];
		const ids = await insert_children(
			children.map((child) => ({
				name: child.name,
				kind: "file" as const,
				updatedAt: child.updatedAt,
				lowercaseExtension: child.extension ?? undefined,
				contentByteSize: child.size ?? undefined,
			})),
		);
		await set_metadata(ids.map((id, index) => [id, children[index]!.entries]));
		const names = (list: typeof children) => list.map((child) => child.name);
		// Fillers with the same time sort by name, so each F row comes before its Q row.
		const fillersByTime = fillerF
			.map((filler, index) => [filler.name, fillerQ[index]!.name])
			.reverse()
			.flat();

		const cases: Array<{ filter: files_table_Filter; namePrefix?: string; expected: string[] }> = [
			{ filter: { kind: "name", field: "name", op: "starts_with", value: "task-f" }, expected: names(fillerF) },
			{
				filter: { kind: "extension", field: "extension", op: "is", value: "MD" },
				expected: ["task-a.md", "task-m.md", "task-z.md"],
			},
			{
				filter: { kind: "extension", field: "extension", op: "is", value: "md" },
				namePrefix: "task-m",
				expected: ["task-m.md"],
			},
			{ filter: { kind: "extension", field: "extension", op: "missing" }, expected: ["notes"] },
			{ filter: { kind: "size", field: "size", op: "is", value: 20 }, expected: ["task-m.md"] },
			{ filter: { kind: "size", field: "size", op: "is", value: 20 }, namePrefix: "task-z", expected: [] },
			{
				filter: { kind: "size", field: "size", op: "missing" },
				expected: ["notes", ...names(fillerF), ...names(fillerQ)],
			},
			{ filter: { kind: "size", field: "size", op: "at_least", value: 25 }, expected: ["task-z.md", "task-a.md"] },
			{ filter: { kind: "size", field: "size", op: "at_most", value: 25 }, expected: ["task-m.md", "task-z.md"] },
			{
				filter: { kind: "date", field: "updated", op: "on", start: DAY, end: DAY + 24 * HOUR },
				expected: ["task-m.md", "task-z.md", "task-a.md"],
			},
			{
				filter: { kind: "date", field: "updated", op: "before", start: DAY, end: DAY + 24 * HOUR },
				expected: fillersByTime,
			},
			{
				filter: { kind: "date", field: "updated", op: "after", start: DAY, end: DAY + 24 * HOUR },
				expected: ["notes"],
			},
			// Every child was created after the first day of 1970, in insert order.
			{ filter: { kind: "date", field: "created", op: "after", start: 0, end: 24 * HOUR }, expected: names(children) },
			{
				filter: { kind: "text", field: "metadata.status", op: "is", value: "OPEN" },
				expected: ["task-a.md", "task-m.md", "task-z.md"],
			},
			{
				filter: { kind: "text", field: "metadata.status", op: "is", value: "open" },
				namePrefix: "task-z",
				expected: ["task-z.md"],
			},
			{
				filter: { kind: "text", field: "metadata.note", op: "starts_with", value: "alp" },
				expected: ["task-a.md", "task-m.md"],
			},
			{
				filter: { kind: "text", field: "metadata.note", op: "present" },
				expected: ["task-a.md", "task-m.md", "task-z.md"],
			},
		];
		for (const { filter, namePrefix = null, expected } of cases) {
			const field = files_table_filter_order_field(filter);
			expect(await read_table({ field, direction: "asc" }, { filter, namePrefix, numItems: 7 })).toEqual(expected);
			expect(await read_table({ field, direction: "desc" }, { filter, namePrefix, numItems: 7 })).toEqual(
				[...expected].reverse(),
			);
			// A page reads its own rows (a field doc and a node for a metadata row) and about 8 fixed
			// docs. A scan that fills the page would read the 75 rows between two matches.
			const cost = await read_page_cost({
				kind: "file",
				sort: { field, direction: "asc" },
				filter,
				namePrefix,
				paginationOpts: { numItems: 7, cursor: null },
			});
			expect(cost.documents).toBeLessThanOrEqual(2 * cost.rows + 10);
		}
	});

	test("rejects invalid filters, a sort that is not the filter's order, a bad name prefix, and bad page limits", async () => {
		const { db, asOwner, parentId } = await seed_folder_table();
		const cases: Array<{ filter: files_table_Filter | null; sort?: string; namePrefix?: string; numItems?: number }> = [
			{ filter: { kind: "name", field: "name", op: "starts_with", value: "" } },
			{ filter: { kind: "name", field: "name", op: "starts_with", value: "file1" } },
			{ filter: { kind: "text", field: "name", op: "present" } },
			{ filter: { kind: "text", field: "metadata.bad key", op: "present" } },
			{ filter: { kind: "size", field: "size", op: "is", value: 0.5 } },
			{ filter: { kind: "size", field: "size", op: "is", value: Number.POSITIVE_INFINITY } },
			{ filter: { kind: "date", field: "created", op: "on", start: 1, end: 0 }, sort: "created" },
			{ filter: { kind: "date", field: "updated", op: "on", start: 0, end: 26 * 60 * 60 * 1000 }, sort: "updated" },
			// The filter fixes the order.
			{ filter: { kind: "size", field: "size", op: "at_least", value: 1 } },
			{ filter: { kind: "extension", field: "extension", op: "is", value: "md" }, sort: "size" },
			{ filter: { kind: "text", field: "metadata.status", op: "present" } },
			// `name starts with` joins only an "is" filter, and follows the name filter rules.
			{ filter: null, namePrefix: "a" },
			{ filter: { kind: "name", field: "name", op: "starts_with", value: "a" }, namePrefix: "b" },
			{ filter: { kind: "size", field: "size", op: "at_least", value: 1 }, sort: "size", namePrefix: "a" },
			{ filter: { kind: "extension", field: "extension", op: "is", value: "md" }, namePrefix: "file1" },
			{ filter: { kind: "extension", field: "extension", op: "is", value: "md" }, namePrefix: "" },
			{ filter: null, numItems: 0 },
			{ filter: null, numItems: 1.5 },
		];
		for (const { filter, sort = "name", namePrefix = null, numItems = 50 } of cases)
			await expect(
				asOwner.query(api.files_tree.list_tree_children_sorted, {
					membershipId: db.membershipId,
					parentId,
					kind: "file",
					sort: [{ field: sort, direction: "asc" }],
					filter,
					namePrefix,
					restricted: false,
					segment: "value",
					paginationOpts: { numItems, cursor: null },
				}),
			).rejects.toThrow("Invalid table filter or page limit.");
	});

	test("hidden children cannot change a member's filtered page", async () => {
		const { db, asOwner, insert_child, set_metadata, add_member, read_page } = await seed_folder_table();
		const publicId = await insert_child({ name: "task.md", kind: "file", updatedAt: 1 });
		await set_metadata([[publicId, [{ key: "status", value: "ready" }]]]);
		const member = await add_member("clerk_filter_hidden", "member");
		const read = () =>
			read_page({
				as: member.as,
				membershipId: member.membershipId,
				kind: "file",
				sort: { field: "name", direction: "asc" },
				filter: { kind: "text", field: "metadata.status", op: "is", value: "ready" },
				paginationOpts: { numItems: 50, cursor: null },
			});

		const before = await read();
		expect(before.page.map((row) => row.name)).toEqual(["task.md"]);

		const hiddenId = await insert_child({ name: "a-hidden-task.md", kind: "file", updatedAt: 1 });
		await set_metadata([[hiddenId, [{ key: "status", value: "ready" }]]]);
		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: hiddenId }))
				._nay,
		).toBeUndefined();
		expect(await read()).toEqual(before);
	});
});

describe("table filter caller", () => {
	test.each([true, false])(
		"both folder table doors throw Unauthenticated for a stale missing caller (membership active=%s)",
		async (active) => {
			const { t, db, asOwner, parentId } = await seed_folder_table();
			await t.run(async (ctx) => {
				await ctx.db.patch("organizations_workspaces_users", db.membershipId, { active });
				await ctx.db.delete("users", db.userId);
			});
			const asAnonymous = t.withIdentity({ issuer: process.env.VITE_CONVEX_HTTP_URL!, subject: db.userId });
			for (const as of [asOwner, asAnonymous]) {
				await expect(
					as.query(api.files_tree.list_tree_children_sorted, {
						membershipId: db.membershipId,
						parentId,
						kind: "file",
						sort: [{ field: "name", direction: "asc" }],
						filter: null,
						namePrefix: null,
						restricted: false,
						segment: "value",
						paginationOpts: { numItems: 50, cursor: null },
					}),
				).rejects.toThrow("Unauthenticated");
				await expect(
					as.query(api.files_tree.list_tree_children_shared, {
						membershipId: db.membershipId,
						parentId,
						kind: "file",
						archived: false,
						principalIndex: 0,
						sort: [{ field: "name", direction: "asc" }],
						filter: null,
						namePrefix: null,
						segment: "value",
						paginationOpts: { numItems: 50, cursor: null },
					}),
				).rejects.toThrow("Unauthenticated");
			}
		},
	);

	test.each([true, false])(
		"both folder table doors throw Unauthenticated for an anonymous tombstone (membership active=%s)",
		async (active) => {
			const { t, db, parentId } = await seed_folder_table();
			await t.run(async (ctx) => {
				await ctx.db.patch("organizations_workspaces_users", db.membershipId, { active });
				await ctx.db.patch("users", db.userId, { clerkUserId: null, deletedAt: Date.now() });
			});
			const as = t.withIdentity({ issuer: process.env.VITE_CONVEX_HTTP_URL!, subject: db.userId });
			await expect(
				as.query(api.files_tree.list_tree_children_sorted, {
					membershipId: db.membershipId,
					parentId,
					kind: "file",
					sort: [{ field: "name", direction: "asc" }],
					filter: null,
					namePrefix: null,
					restricted: false,
					segment: "value",
					paginationOpts: { numItems: 50, cursor: null },
				}),
			).rejects.toThrow("Unauthenticated");
			await expect(
				as.query(api.files_tree.list_tree_children_shared, {
					membershipId: db.membershipId,
					parentId,
					kind: "file",
					archived: false,
					principalIndex: 0,
					sort: [{ field: "name", direction: "asc" }],
					filter: null,
					namePrefix: null,
					segment: "value",
					paginationOpts: { numItems: 50, cursor: null },
				}),
			).rejects.toThrow("Unauthenticated");
		},
	);
});

describe("create-time metadata", () => {
	async function read_metadata_docs(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
		return await t.run(async (ctx) =>
			(await ctx.db.query("files_metadata_docs").collect()).filter(
				(doc) => doc.sourceKind === "committed" && doc.fileNodeId === nodeId && doc.fieldPath.startsWith("metadata."),
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
		expect((await read_metadata_docs(t, upload._yay.nodeId)).map((doc) => doc.fieldPath).sort()).toEqual([
			"metadata.original-name",
			"metadata.original-name",
			"metadata.source",
			"metadata.source",
		]);

		// The map is searchable straight away, without anybody opening the file.
		expect(
			(
				await test_meta_search(t, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					plan: { op: "eq", fieldPath: "metadata.source", value: "upload" },
				})
			).items,
		).toMatchObject([{ path: "/quarterly-report.pdf", target: { kind: "saved", id: upload._yay.nodeId } }]);
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
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("moveCohortId", undefined),
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

	test("the upload keeps its create-time keys after publication", async () => {
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
			// A smaller confirmed size still preserves the create-time keys.
			size: 4096,
		});
		if (upload._nay) throw new Error(upload._nay.message);

		await t.mutation(internal.r2.process_uploaded_asset_event, {
			assetId: upload._yay.assetId,
			r2Key: r2_create_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: upload._yay.assetId,
			}),
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
	const insideNodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: insidePath,
		markdown: "# Inside\n\nbase content.",
	});
	const collideNodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: collidePath,
		markdown: "# Collide\n\nbase content.",
	});

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
		text_search_files_all_pages(asUser, {
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
	const nodeId = await test_materialize_markdown_file({ t, asUser, db, path, markdown: "# Doc\n\nbase content." });

	const pending = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId,
		unstagedMarkdown: "# Doc\n\narchivedpendingneedle added before archiving.",
	});
	if (pending._nay) throw new Error(pending._nay.message);

	const search = () =>
		text_search_files_all_pages(asUser, {
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

	const renameNodeId = await test_insert_searchable_markdown_file({
		t,
		db,
		path: "/rename-source.md",
		markdown: "# Rename\n\nscopecommittedneedle before rename.",
	});
	const moveNodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/move-source.md",
		markdown: "# Move\n\nbase content.",
	});
	const targetFolderId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			contentType: null,
			assetId: null,
			contentByteSize: null,
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: null,
			isRestrictedScopeRoot: false,
			writePolicy: null,

			archiveOperationId: null,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "/move-target",
			treePath: "/move-target/",
			pathDepth: 1,
			lowercaseExtension: null,
			name: "move-target",
			sortName: files_sort_text_key("move-target"),
			kind: "folder",
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: Date.now(),
			newChildWritePolicy: null,
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
		text_search_files_all_pages(asUser, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query,
			numItems: 10,
			cursor: null,
			pathPrefix,
		});

	const renamed = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: renameNodeId,
		path: "rename-target.md",
	});
	if (renamed._nay) throw new Error(renamed._nay.message);
	expect((await search("scopecommittedneedle")).items.map((item) => item.path)).toEqual(["/rename-target.md"]);

	const moved = await test_move_nodes(t, asUser, {
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

	const archiveNodeId = await test_insert_searchable_markdown_file({
		t,
		db,
		path: "/archive-source.md",
		markdown: "# Archive\n\nscopearchivecommittedneedle before archive.",
	});

	const search = (query: string) =>
		text_search_files_all_pages(asUser, {
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
	const pendingNodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: pendingPath,
		markdown: "# Pending\n\nbase content.",
	});
	await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: committedPath,
		markdown: "# Committed\n\npagingneedle stays in the committed index.",
	});

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

test("search_saved finds each saved file once by its content, with its best chunk", async () => {
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
	// so the one-row-per-file rule has something to merge.
	const filler = "lorem ipsum dolor sit amet ".repeat(60);
	const singleChunkNodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/palette-single.md",
		markdown: "# Single\n\nOnly one palneedle lives here.",
	});
	const doubleChunkNodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/palette-double.md",
		markdown: `# Double\n\nFirst palneedle here.\n\n${filler}\n\nSecond palneedle here.`,
	});

	const search = async (text: string) =>
		(
			await asUser.query(api.files_nodes.search_saved, {
				membershipId: db.membershipId,
				clause: { kind: "content", text },
				paginationOpts: { numItems: 50, cursor: null },
			})
		).page;
	const found = await search("palneedle");
	expect(found).toHaveLength(2);
	const resultsByPath = new Map(found.map((row) => [row.kind === "problem" ? row.message : row.path, row]));
	expect(resultsByPath.get("/palette-single.md")).toMatchObject({ nodeId: singleChunkNodeId });
	expect(resultsByPath.get("/palette-double.md")).toMatchObject({ nodeId: doubleChunkNodeId });
	expect(resultsByPath.get("/palette-single.md")).toMatchObject({ textChunk: expect.stringContaining("palneedle") });

	// The agent's text search: a full page contains only the selected file, even when other files
	// match the text.
	const scopedPage = await text_search_files_all_pages(asUser, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		hasWorkspaceRead: true,
		query: "palneedle",
		targets: [{ kind: "saved", id: doubleChunkNodeId }],
		numItems: 2,
		cursor: null,
	});
	expect(scopedPage.items.map((item) => item.target)).toEqual([
		{ kind: "saved", id: doubleChunkNodeId },
		{ kind: "saved", id: doubleChunkNodeId },
	]);

	// Bounds: a blank query and an over-200-character query return empty without touching the
	// search index.
	expect(await search("  ")).toEqual([]);
	expect(await search(`palneedle ${"x".repeat(200)}`)).toEqual([]);

	// No identity is the only hard refusal.
	await expect(
		t.query(api.files_nodes.search_saved, {
			membershipId: db.membershipId,
			clause: { kind: "content", text: "palneedle" },
			paginationOpts: { numItems: 50, cursor: null },
		}),
	).rejects.toThrow(/Unauthenticated/);
});
