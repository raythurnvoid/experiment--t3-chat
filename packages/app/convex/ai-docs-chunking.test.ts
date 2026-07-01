import { expect, test } from "vitest";
import { db_replace_file_chunks } from "./files_nodes.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";

test("db_replace_file_chunks replaces existing chunk rows for a page", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

	await t.run(async (ctx) => {
		const basePageData = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: Date.now(),
		} as const;

		const nodeId = await ctx.db.insert("files_nodes", {
			...basePageData,
			path: "/chunked-page",
			treePath: "/chunked-page",
			pathDepth: 1,
			lowercaseExtension: null,
			name: "chunked-page",
			kind: "file",
			archiveOperationId: undefined,
		});
		const oldMarkdownChunkId = await ctx.db.insert("files_markdown_chunks", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
			sourceKind: "committed",
			yjsSequence: 1,
			chunkIndex: 0,
			markdownChunk: "Old markdown chunk",
			startIndex: 0,
			endIndex: "Old markdown chunk".length,
			lineStart: 1,
			lineEnd: 1,
			chunkFlags: 0,
		});
		const oldPlainTextChunkId = await ctx.db.insert("files_plain_text_chunks", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
			sourceKind: "committed",
			yjsSequence: 1,
			markdownChunkId: oldMarkdownChunkId,
			chunkIndex: 0,
			path: "/chunked-page",
			plainTextChunk: "Old plain text chunk",
			markdownChunk: "Old markdown chunk",
			startIndex: 0,
			endIndex: "Old markdown chunk".length,
			lineStart: 1,
			lineEnd: 1,
			chunkFlags: 0,
			hasChunkAbove: false,
			hasChunkBelow: false,
		});

		const result = await db_replace_file_chunks(ctx, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			yjsSequence: 2,
			markdownContent: "# Fresh heading\n\nFresh paragraph",
		});
		expect(result._nay).toBeUndefined();

		const markdownChunks = await ctx.db
			.query("files_markdown_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect();
		const plainTextChunks = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect();

		expect(await ctx.db.get("files_markdown_chunks", oldMarkdownChunkId)).toBeNull();
		expect(await ctx.db.get("files_plain_text_chunks", oldPlainTextChunkId)).toBeNull();
		expect(markdownChunks.length).toBeGreaterThan(0);
		expect(plainTextChunks.length).toBeGreaterThan(0);
		expect(markdownChunks.every((chunk) => chunk.sourceKind === "committed")).toBe(true);
		expect(markdownChunks.every((chunk) => chunk.yjsSequence === 2)).toBe(true);
		expect(plainTextChunks.every((chunk) => chunk.yjsSequence === 2)).toBe(true);
		expect(markdownChunks.every((chunk) => chunk.startIndex >= 0 && chunk.endIndex > chunk.startIndex)).toBe(true);
		for (const chunk of plainTextChunks) {
			const markdownChunk = markdownChunks.find((candidate) => candidate._id === chunk.markdownChunkId);
			if (!markdownChunk) throw new Error("Expected linked Markdown chunk");
			expect(chunk).toMatchObject({
				markdownChunk: markdownChunk.markdownChunk,
				startIndex: markdownChunk.startIndex,
				endIndex: markdownChunk.endIndex,
				lineStart: markdownChunk.lineStart,
				lineEnd: markdownChunk.lineEnd,
				chunkFlags: markdownChunk.chunkFlags,
				hasChunkAbove: chunk.chunkIndex > 0,
				hasChunkBelow: chunk.chunkIndex < plainTextChunks.length - 1,
			});
		}
	});
});
