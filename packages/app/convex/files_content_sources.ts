// Prepare exact source in bounded steps before publication.

import { Result } from "common/errors-as-values-utils.ts";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import type { ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import { files_saved_content_db_get_head, files_saved_content_yjs_owner } from "../server/files-saved-content-head.ts";
import { files_content_heads_db_for_head } from "../server/files-content-heads.ts";
import { files_chunk_markdown_bounds } from "../server/files-markdown-chunking-mastra.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_compute_wc_counts } from "./files_nodes_create_db.ts";
import { r2_UNFINALIZED_ASSET_TTL_MS } from "./r2_assets.ts";

export async function files_content_sources_action_prepare(
	ctx: ActionCtx,
	args: {
		nodeId: Id<"files_nodes">;
		assetId: Id<"files_r2_assets">;
		text: string;
		yjsSequence?: number;
		rootKind?: "rich_text" | "plain_text";
	},
): Promise<
	{ _yay: Id<"files_saved_content_heads">; _nay?: undefined } | { _nay: { message: string }; _yay?: undefined }
> {
	const prepared = await ctx.runMutation(internal.files_content_sources.begin, {
		nodeId: args.nodeId,
		assetId: args.assetId,
		textByteSize: files_get_utf8_byte_size(args.text),
		rootKind: args.rootKind,
	});
	if (!prepared) return Result({ _nay: { message: "The file changed while preparing its content." } });
	const chunks =
		prepared.textKind === "rich_text"
			? await files_chunk_markdown_bounds(args.text)
			: Result({ _yay: files_chunk_plain_text(args.text) });
	if (chunks._nay) return Result({ _nay: { message: chunks._nay.message } });
	for (let start = 0; start < chunks._yay.length; start += 100) {
		await ctx.runMutation(internal.files_content_sources.stage_page, {
			headId: prepared.headId,
			firstChunkIndex: start,
			yjsSequence: args.yjsSequence,
			chunks: chunks._yay.slice(start, start + 100).map((chunk) => ({
				chunkIndex: chunk.chunkIndex,
				textChunk: chunk.textChunk,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				chunkFlags: chunk.chunkFlags,
			})),
		});
	}
	await ctx.runMutation(internal.files_content_sources.seal, {
		headId: prepared.headId,
		chunkCount: chunks._yay.length,
		textLength: args.text.length,
		...files_compute_wc_counts(args.text),
	});
	return Result({ _yay: prepared.headId });
}

export const begin = internalMutation({
	args: {
		nodeId: v.id("files_nodes"),
		assetId: v.id("files_r2_assets"),
		textByteSize: v.number(),
		rootKind: v.optional(v.union(v.literal("rich_text"), v.literal("plain_text"))),
	},
	returns: v.union(
		v.object({
			headId: v.id("files_saved_content_heads"),
			textKind: v.union(v.literal("rich_text"), v.literal("plain_text")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const previous = await files_saved_content_db_get_head(ctx.db, args.nodeId);
		const asset = await ctx.db.get("files_r2_assets", args.assetId);
		if (!previous || !asset) return null;
		const textKind = args.rootKind ?? previous.textKind;
		if (
			!textKind ||
			asset.organizationId !== previous.organizationId ||
			asset.workspaceId !== previous.workspaceId ||
			asset.size !== args.textByteSize
		)
			throw should_never_happen("Source preparation does not match its file", args);
		const { _id: _id, _creationTime: _time, ...fields } = previous;
		const headId = await ctx.db.insert("files_saved_content_heads", {
			...fields,
			textKind,
			assetId: args.assetId,
			contentByteSize: args.textByteSize,
			statsId: null,
			ready: false,
			yjsContentHeadId: files_saved_content_yjs_owner(previous),
		});
		await ctx.scheduler.runAfter(r2_UNFINALIZED_ASSET_TTL_MS, internal.files_content_saves.retire, { headId });
		return { headId, textKind };
	},
});

export const stage_page = internalMutation({
	args: {
		headId: v.id("files_saved_content_heads"),
		firstChunkIndex: v.number(),
		yjsSequence: v.optional(v.number()),
		chunks: v.array(
			v.object({
				chunkIndex: v.number(),
				textChunk: v.string(),
				startIndex: v.number(),
				endIndex: v.number(),
				lineStart: v.number(),
				lineEnd: v.number(),
				chunkFlags: v.number(),
			}),
		),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const head = await ctx.db.get("files_saved_content_heads", args.headId);
		if (!head || head.retired) return;
		if (head.ready) return;
		const last = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", head._id))
			.order("desc")
			.first();
		const nextIndex = last ? last.chunkIndex + 1 : 0;
		if (args.firstChunkIndex < nextIndex) return;
		if (args.firstChunkIndex !== nextIndex || args.chunks.length === 0 || args.chunks.length > 100)
			throw should_never_happen("Source page is out of order", { headId: head._id });
		let end = last?.endIndex ?? 0;
		for (const [index, chunk] of args.chunks.entries()) {
			if (
				chunk.chunkIndex !== nextIndex + index ||
				chunk.startIndex !== end ||
				chunk.endIndex !== chunk.startIndex + chunk.textChunk.length
			)
				throw should_never_happen("Source chunks are not complete", { headId: head._id });
			end = chunk.endIndex;
		}
		const db = files_content_heads_db_for_head(ctx, head);
		await Promise.all(
			args.chunks.map((chunk) =>
				db.insert("files_text_chunks", {
					organizationId: head.organizationId,
					workspaceId: head.workspaceId,
					fileNodeId: head.fileNodeId,
					sourceKind: "committed",
					yjsSequence: args.yjsSequence,
					...chunk,
				}),
			),
		);
	},
});

export const seal = internalMutation({
	args: {
		headId: v.id("files_saved_content_heads"),
		chunkCount: v.number(),
		textLength: v.number(),
		charCount: v.number(),
		wordCount: v.number(),
		lineCount: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const head = await ctx.db.get("files_saved_content_heads", args.headId);
		if (!head || head.retired) return;
		if (head.ready) return;
		const last = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", head._id))
			.order("desc")
			.first();
		if ((last ? last.chunkIndex + 1 : 0) !== args.chunkCount || (last?.endIndex ?? 0) !== args.textLength)
			throw should_never_happen("Source chunks are not complete", { headId: head._id });
		const statsId = await files_content_heads_db_for_head(ctx, head).insert("file_stats", {
			organizationId: head.organizationId,
			workspaceId: head.workspaceId,
			fileNodeId: head.fileNodeId,
			charCount: args.charCount,
			lineCount: args.lineCount,
			wordCount: args.wordCount,
		});
		await ctx.db.patch("files_saved_content_heads", head._id, { statsId, ready: true });
	},
});
