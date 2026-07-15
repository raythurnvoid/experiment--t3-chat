import { v } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { doc } from "convex-helpers/validators";
import { internalMutation, internalQuery } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import app_convex_schema from "./schema.ts";

// Reuse the V8 context between invocations to skip the module-eval tax (same flag as
// files_nodes.ts — see the comment there; no mutable module-level state allowed here).
export const experimental_reuseContext = true;

export const load_thread_tmp_files = internalQuery({
	args: {
		threadId: v.id("ai_chat_threads"),
	},
	returns: v.object({
		file_nodes: v.array(doc(app_convex_schema, "ai_chat_files")),
		file_nodes_content_dict: v.record(v.id("ai_chat_files"), doc(app_convex_schema, "ai_chat_files_content")),
	}),
	handler: async (ctx, args) => {
		const fileNodes = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.threadId))
			.collect();
		const fileNodesContent = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_thread_fileNode", (q) => q.eq("threadId", args.threadId))
			.collect();
		const fileNodesContentDict: Record<Id<"ai_chat_files">, Doc<"ai_chat_files_content">> = {};
		for (const content of fileNodesContent) {
			fileNodesContentDict[content.fileNodeId] = content;
		}

		return {
			file_nodes: fileNodes,
			file_nodes_content_dict: fileNodesContentDict,
		};
	},
});

export type ai_chat_files_load_thread_tmp_files_Result =
	typeof load_thread_tmp_files extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const patch_thread_tmp_files = internalMutation({
	args: {
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		fileNodes: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("file"), v.literal("directory"), v.literal("symlink")),
				mode: v.number(),
				size: v.number(),
				mtime: v.number(),
				symlinkTargetPath: v.optional(v.string()),
			}),
		),
		fileNodesContentDict: v.record(v.string(), v.bytes()),
		deletePaths: v.array(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existingAiChatFiles = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.threadId))
			.collect();
		const existingByPath = new Map(existingAiChatFiles.map((fileNode) => [fileNode.path, fileNode]));

		await Promise.all(
			args.deletePaths.map(async (path) => {
				const existing = existingByPath.get(path);
				if (!existing) {
					return;
				}
				const aiChatFilesContent = await ctx.db
					.query("ai_chat_files_content")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", existing._id))
					.collect();
				await Promise.all([
					...aiChatFilesContent.map((row) => ctx.db.delete("ai_chat_files_content", row._id)),
					ctx.db.delete("ai_chat_files", existing._id),
				]);
			}),
		);

		await Promise.all(
			args.fileNodes.map(async (fileNode) => {
				const doc = {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					threadId: args.threadId,
					path: fileNode.path,
					kind: fileNode.kind,
					mode: fileNode.mode,
					size: fileNode.size,
					mtime: fileNode.mtime,
					...(fileNode.kind === "symlink" && fileNode.symlinkTargetPath !== undefined
						? { symlinkTargetPath: fileNode.symlinkTargetPath }
						: {}),
				};
				const existing = existingByPath.get(fileNode.path);
				const fileNodeId = existing?._id ?? (await ctx.db.insert("ai_chat_files", doc));
				if (existing) {
					await ctx.db.replace("ai_chat_files", existing._id, doc);
				}

				if (fileNode.kind !== "file") {
					if (existing) {
						const aiChatFilesContent = await ctx.db
							.query("ai_chat_files_content")
							.withIndex("by_fileNode", (q) => q.eq("fileNodeId", existing._id))
							.collect();
						await Promise.all(aiChatFilesContent.map((row) => ctx.db.delete("ai_chat_files_content", row._id)));
					}
					return;
				}

				const bytes = args.fileNodesContentDict[fileNode.path];
				if (bytes === undefined) {
					return;
				}
				const existingAiChatFilesContent = await ctx.db
					.query("ai_chat_files_content")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", fileNodeId))
					.first();
				const contentDoc = {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					threadId: args.threadId,
					fileNodeId,
					bytes,
				};
				if (existingAiChatFilesContent) {
					await ctx.db.replace("ai_chat_files_content", existingAiChatFilesContent._id, contentDoc);
				} else {
					await ctx.db.insert("ai_chat_files_content", contentDoc);
				}
			}),
		);

		return null;
	},
});

export type ai_chat_files_patch_thread_tmp_files_Args =
	typeof patch_thread_tmp_files extends RegisteredMutation<infer _Visibility, infer Args, infer _ReturnValue>
		? Args
		: never;

export const copy_thread_tmp_files = internalMutation({
	args: {
		organizationId: v.string(),
		workspaceId: v.string(),
		sourceThreadId: v.id("ai_chat_threads"),
		targetThreadId: v.id("ai_chat_threads"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const sourceAiChatFiles = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.sourceThreadId))
			.collect();
		const sourceAiChatFilesContent = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_thread_fileNode", (q) => q.eq("threadId", args.sourceThreadId))
			.collect();
		const contentByFileNodeId = new Map(sourceAiChatFilesContent.map((content) => [content.fileNodeId, content]));

		// The branch target is created in the same transaction, so source rows are inserted as-is.
		await Promise.all(
			sourceAiChatFiles.map(async (fileNode) => {
				const fileNodeId = await ctx.db.insert("ai_chat_files", {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					threadId: args.targetThreadId,
					path: fileNode.path,
					kind: fileNode.kind,
					mode: fileNode.mode,
					size: fileNode.size,
					mtime: fileNode.mtime,
					...(fileNode.symlinkTargetPath !== undefined ? { symlinkTargetPath: fileNode.symlinkTargetPath } : {}),
				});
				const content = contentByFileNodeId.get(fileNode._id);
				if (content) {
					await ctx.db.insert("ai_chat_files_content", {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						threadId: args.targetThreadId,
						fileNodeId,
						bytes: content.bytes,
					});
				}
			}),
		);

		return null;
	},
});
