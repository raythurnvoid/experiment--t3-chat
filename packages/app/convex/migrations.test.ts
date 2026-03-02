import { expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_hardcoded } from "./setup.test.ts";
import { pages_FIRST_VERSION, pages_ROOT_ID } from "../server/pages.ts";

test("backfill_pages_chunk_rows rebuilds markdown/plain-text chunk tables", async () => {
	const t = test_convex();

	await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", {
			clerkUserId: null,
			anonymousAuthToken: null,
		});

		const pageId = await ctx.db.insert("pages", {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			path: "/chunk-backfill",
			name: "chunk-backfill",
			version: pages_FIRST_VERSION,
			parentId: pages_ROOT_ID,
			createdBy: userId,
			updatedBy: String(userId),
			updatedAt: Date.now(),
			archiveOperationId: undefined,
		});

		const markdownContentId = await ctx.db.insert("pages_markdown_content", {
			workspace_id: test_mocks_hardcoded.workspace_id.workspace_1,
			project_id: test_mocks_hardcoded.project_id.project_1,
			page_id: pageId,
			content: [
				"# Chunk backfill",
				"",
				"Searchable sentence alpha beta.",
				"",
				"```ts",
				"const chunkValue = 123;",
				"```",
				"",
				"| Name | Value |",
				"| --- | --- |",
				"| one | 1 |",
			].join("\n"),
			is_archived: false,
			yjs_sequence: 5,
			updated_at: Date.now(),
			updated_by: String(userId),
		});

		await ctx.db.patch("pages", pageId, {
			markdownContentId,
		});

		const backfillResult = await ctx.runMutation(internal.migrations.backfill_pages_chunk_rows, {
			limit: 100,
		});

		expect(backfillResult.scanned).toBeGreaterThanOrEqual(1);
		expect(backfillResult.rebuilt).toBeGreaterThanOrEqual(1);

		const markdownChunks = await ctx.db
			.query("pages_markdown_chunks")
			.withIndex("by_workspace_project_page_sequenceChunk", (q) =>
				q
					.eq("workspaceId", test_mocks_hardcoded.workspace_id.workspace_1)
					.eq("projectId", test_mocks_hardcoded.project_id.project_1)
					.eq("pageId", pageId),
			)
			.order("asc")
			.collect();
		const plainTextChunks = await ctx.db
			.query("pages_plain_text_chunks")
			.withIndex("by_workspace_project_page_sequenceChunk", (q) =>
				q
					.eq("workspaceId", test_mocks_hardcoded.workspace_id.workspace_1)
					.eq("projectId", test_mocks_hardcoded.project_id.project_1)
					.eq("pageId", pageId),
			)
			.order("asc")
			.collect();

		expect(markdownChunks.length).toBeGreaterThan(0);
		expect(plainTextChunks.length).toBe(markdownChunks.length);

		for (let index = 0; index < markdownChunks.length; index++) {
			expect(markdownChunks[index]!.chunkIndex).toBe(index);
			expect(markdownChunks[index]!.lineStart).toBeGreaterThanOrEqual(1);
			expect(markdownChunks[index]!.lineEnd).toBeGreaterThanOrEqual(markdownChunks[index]!.lineStart);
		}

		const pageTextContent = await ctx.runQuery(api.ai_docs_temp.get_page_text_content_by_page_id, {
			workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
			projectId: test_mocks_hardcoded.project_id.project_1,
			pageId,
		});
		expect(pageTextContent).toContain("Searchable sentence alpha beta.");
		expect(pageTextContent).toContain("const chunkValue = 123;");
	});
});
