import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_file_index,
	test_mocks_fill_db_with,
} from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("native Save replaces exact chunks and their linked search rows", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/chunked-page.md",
		textContent: "Old markdown chunk",
	});
	expect(
		await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		}),
	).toHaveProperty("_yay");
	const previousHeadId = await t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))!.contentHeadId!);
	const freshText = "# Fresh heading\n\nFresh paragraph";
	expect(
		await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			requestId: "replace-chunks",
			text: freshText,
		}),
	).toHaveProperty("_yay");
	await test_finish_file_index(t, nodeId);
	await t.mutation(internal.files_content_saves.retire, { headId: previousHeadId });
	await t.mutation(internal.files_content_saves.discard, { headId: previousHeadId });
	await t.run(async (ctx) => {
		const node = (await ctx.db.get("files_nodes", nodeId))!;
		const textChunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", node.contentHeadId!))
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
		expect(
			await ctx.db
				.query("files_text_chunks")
				.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", previousHeadId))
				.collect(),
		).toEqual([]);
		expect(textChunks.map((chunk) => chunk.textChunk).join("")).toBe(freshText);
		expect(plainTextChunks.length).toBeGreaterThan(0);
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
