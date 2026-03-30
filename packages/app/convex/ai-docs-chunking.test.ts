import { expect, test } from "vitest";
import { db_upsert_page_chunks } from "./ai_docs_temp.ts";
import { test_convex, test_mocks_hardcoded } from "./setup.test.ts";
import { pages_FIRST_VERSION, pages_ROOT_ID } from "../server/pages.ts";

test("db_upsert_page_chunks replaces existing chunk rows for a page", async () => {
	const t = test_convex();

	await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", {
			clerkUserId: null,
		});

		const basePageData = {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			version: pages_FIRST_VERSION,
			parentId: pages_ROOT_ID,
			createdBy: userId,
			updatedBy: String(userId),
			updatedAt: Date.now(),
		} as const;

		const pageId = await ctx.db.insert("pages", {
			...basePageData,
			path: "/chunked-page",
			name: "chunked-page",
			archiveOperationId: undefined,
		});
		const oldMarkdownChunkId = await ctx.db.insert("pages_markdown_chunks", {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			pageId,
			yjsSequence: 1,
			chunkIndex: 0,
			markdownChunk: "Old markdown chunk",
			lineStart: 1,
			lineEnd: 1,
			chunkFlags: 0,
		});
		const oldPlainTextChunkId = await ctx.db.insert("pages_plain_text_chunks", {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			pageId,
			yjsSequence: 1,
			chunkIndex: 0,
			plainTextChunk: "Old plain text chunk",
			markdownChunkId: oldMarkdownChunkId,
		});

		const result = await db_upsert_page_chunks(ctx, {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			pageId,
			yjsSequence: 2,
			markdownContent: "# Fresh heading\n\nFresh paragraph",
		});
		expect(result._nay).toBeUndefined();

		const markdownChunks = await ctx.db
			.query("pages_markdown_chunks")
			.withIndex("by_workspace_project_page_sequenceChunk", (q) =>
				q
					.eq("workspaceId", test_mocks_hardcoded.workspace_id.workspace_1)
					.eq("projectId", test_mocks_hardcoded.project_id.project_1)
					.eq("pageId", pageId),
			)
			.collect();
		const plainTextChunks = await ctx.db
			.query("pages_plain_text_chunks")
			.withIndex("by_workspace_project_page_sequenceChunk", (q) =>
				q
					.eq("workspaceId", test_mocks_hardcoded.workspace_id.workspace_1)
					.eq("projectId", test_mocks_hardcoded.project_id.project_1)
					.eq("pageId", pageId),
			)
			.collect();

		expect(await ctx.db.get("pages_markdown_chunks", oldMarkdownChunkId)).toBeNull();
		expect(await ctx.db.get("pages_plain_text_chunks", oldPlainTextChunkId)).toBeNull();
		expect(markdownChunks.length).toBeGreaterThan(0);
		expect(plainTextChunks.length).toBeGreaterThan(0);
		expect(markdownChunks.every((chunk) => chunk.yjsSequence === 2)).toBe(true);
		expect(plainTextChunks.every((chunk) => chunk.yjsSequence === 2)).toBe(true);
		expect(
			plainTextChunks.every((chunk) => markdownChunks.some((markdownChunk) => markdownChunk._id === chunk.markdownChunkId)),
		).toBe(true);
	});
});
