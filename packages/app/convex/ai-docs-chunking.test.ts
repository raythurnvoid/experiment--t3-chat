import { expect, test } from "vitest";
import { internal } from "./_generated/api.js";
import { test_convex, test_mocks_hardcoded } from "./setup.test.ts";
import { pages_FIRST_VERSION, pages_ROOT_ID } from "../server/pages.ts";

test("delete_all_archived_pages also deletes chunk rows", async () => {
	const t = test_convex();

	await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", {
			clerkUserId: null,
			anonymousAuthToken: null,
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

		const activePageId = await ctx.db.insert("pages", {
			...basePageData,
			path: "/active-page",
			name: "active-page",
			archiveOperationId: undefined,
		});
		const archivedPageId = await ctx.db.insert("pages", {
			...basePageData,
			path: "/archived-page",
			name: "archived-page",
			archiveOperationId: "archive-op-1",
		});

		const [activeMarkdownContentId, archivedMarkdownContentId] = await Promise.all([
			ctx.db.insert("pages_markdown_content", {
				workspace_id: test_mocks_hardcoded.workspace_id.workspace_1,
				project_id: test_mocks_hardcoded.project_id.project_1,
				page_id: activePageId,
				content: "Active content",
				is_archived: false,
				yjs_sequence: 1,
				updated_at: Date.now(),
				updated_by: String(userId),
			}),
			ctx.db.insert("pages_markdown_content", {
				workspace_id: test_mocks_hardcoded.workspace_id.workspace_1,
				project_id: test_mocks_hardcoded.project_id.project_1,
				page_id: archivedPageId,
				content: "Archived content",
				is_archived: true,
				yjs_sequence: 1,
				updated_at: Date.now(),
				updated_by: String(userId),
			}),
		]);

		await Promise.all([
			ctx.db.patch("pages", activePageId, { markdownContentId: activeMarkdownContentId }),
			ctx.db.patch("pages", archivedPageId, { markdownContentId: archivedMarkdownContentId }),
		]);

		const activeMarkdownChunkId = await ctx.db.insert("pages_markdown_chunks", {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			pageId: activePageId,
			yjsSequence: 1,
			chunkIndex: 0,
			markdownChunk: "Active markdown chunk",
			lineStart: 1,
			lineEnd: 1,
			chunkFlags: 0,
		});
		const archivedMarkdownChunkId = await ctx.db.insert("pages_markdown_chunks", {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			pageId: archivedPageId,
			yjsSequence: 1,
			chunkIndex: 0,
			markdownChunk: "Archived markdown chunk",
			lineStart: 1,
			lineEnd: 1,
			chunkFlags: 0,
		});

		await Promise.all([
			ctx.db.insert("pages_plain_text_chunks", {
				workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
				projectId: test_mocks_hardcoded.project_id.project_1,
				pageId: activePageId,
				yjsSequence: 1,
				chunkIndex: 0,
				plainTextChunk: "Active plain text chunk",
				markdownChunkId: activeMarkdownChunkId,
			}),
			ctx.db.insert("pages_plain_text_chunks", {
				workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
				projectId: test_mocks_hardcoded.project_id.project_1,
				pageId: archivedPageId,
				yjsSequence: 1,
				chunkIndex: 0,
				plainTextChunk: "Archived plain text chunk",
				markdownChunkId: archivedMarkdownChunkId,
			}),
		]);

		const deleteResult = await ctx.runMutation(internal.migrations.delete_all_archived_pages, {});
		expect(deleteResult.pages).toBe(1);
		expect(deleteResult.pagesMarkdownChunks).toBe(1);
		expect(deleteResult.pagesPlainTextChunks).toBe(1);

		const activePage = await ctx.db.get("pages", activePageId);
		const archivedPage = await ctx.db.get("pages", archivedPageId);
		expect(activePage).not.toBeNull();
		expect(archivedPage).toBeNull();

		const remainingActiveChunks = await ctx.db
			.query("pages_markdown_chunks")
			.withIndex("by_workspace_project_page_sequenceChunk", (q) =>
				q
					.eq("workspaceId", test_mocks_hardcoded.workspace_id.workspace_1)
					.eq("projectId", test_mocks_hardcoded.project_id.project_1)
					.eq("pageId", activePageId),
			)
			.collect();
		expect(remainingActiveChunks).toHaveLength(1);
	});
});
