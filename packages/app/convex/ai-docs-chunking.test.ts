import { expect, test } from "vitest";
import { db_replace_file_chunks } from "./files_nodes_content.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";

test("db_replace_file_chunks replaces existing chunk rows for a page", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

	await t.run(async (ctx) => {
		const now = Date.now();
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content",
			r2Bucket: "test-bucket",
			size: 0,
			createdBy: db.userId,
			updatedAt: now,
		});
		const snapshotAssetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "yjs_snapshot",
			r2Bucket: "test-bucket",
			size: 0,
			createdBy: db.userId,
			updatedAt: now,
		});
		const basePageData = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: now,
		} as const;

		const nodeId = await ctx.db.insert("files_nodes", {
			...basePageData,
			path: "/chunked-page",
			treePath: "/chunked-page",
			pathDepth: 1,
			lowercaseExtension: null,
			name: "chunked-page",
			kind: "file",
			assetId,
			yjsRootKind: "rich_text",
			archiveOperationId: undefined,
		});
		const snapshotId = await ctx.db.insert("files_yjs_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
			sequence: 1,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			updatedBy: String(db.userId),
			updatedAt: now,
		});
		const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
			lastSequence: 1,
			unmaterializedUpdateCount: 0,
			unmaterializedUpdateBytes: 0,
			lineageGeneration: 0,
		});
		await ctx.db.patch("files_nodes", nodeId, {
			yjsSnapshotId: snapshotId,
			yjsLastSequenceId: lastSequenceId,
		});

		const oldTextChunkId = await ctx.db.insert("files_text_chunks", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
			sourceKind: "committed",
			yjsSequence: 1,
			chunkIndex: 0,
			textChunk: "Old markdown chunk",
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
			textChunkId: oldTextChunkId,
			chunkIndex: 0,
			path: "/chunked-page",
			plainTextChunk: "Old plain text chunk",
			textChunk: "Old markdown chunk",
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
			textContent: "# Fresh heading\n\nFresh paragraph",
		});
		expect(result._nay).toBeUndefined();

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

		expect(await ctx.db.get("files_text_chunks", oldTextChunkId)).toBeNull();
		expect(await ctx.db.get("files_plain_text_chunks", oldPlainTextChunkId)).toBeNull();
		expect(textChunks.length).toBeGreaterThan(0);
		expect(plainTextChunks.length).toBeGreaterThan(0);
		expect(textChunks.every((chunk) => chunk.sourceKind === "committed")).toBe(true);
		expect(textChunks.every((chunk) => chunk.yjsSequence === 2)).toBe(true);
		expect(plainTextChunks.every((chunk) => chunk.yjsSequence === 2)).toBe(true);
		expect(textChunks.every((chunk) => chunk.startIndex >= 0 && chunk.endIndex > chunk.startIndex)).toBe(true);
		for (const chunk of plainTextChunks) {
			const textChunk = textChunks.find((candidate) => candidate._id === chunk.textChunkId);
			if (!textChunk) throw new Error("Expected linked text chunk");
			expect(chunk).toMatchObject({
				textChunk: textChunk.textChunk,
				startIndex: textChunk.startIndex,
				endIndex: textChunk.endIndex,
				lineStart: textChunk.lineStart,
				lineEnd: textChunk.lineEnd,
				chunkFlags: textChunk.chunkFlags,
				hasChunkAbove: chunk.chunkIndex > 0,
				hasChunkBelow: chunk.chunkIndex < plainTextChunks.length - 1,
			});
		}
	});
});
