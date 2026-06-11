import { v } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { doc } from "convex-helpers/validators";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import app_convex_schema from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { Result } from "../src/lib/errors-as-values-utils.ts";

const AI_CHAT_TMP_MAX_PATHS = 1000;
const AI_CHAT_TMP_MAX_BYTES = 5_000_000;
const AI_CHAT_TMP_FILE_MAX_BYTES = 512_000;
const textEncoder = new TextEncoder();

type TmpEntryInput = {
	path: string;
	kind: "file" | "directory" | "symlink";
	mode: number;
	size: number;
	mtime: number;
	symlinkTargetPath?: string;
};

type TmpContentInput = {
	path: string;
	bytes: ArrayBuffer;
};

function normalize_path(path: string) {
	const parts: string[] = [];
	const normalizedInput = path.replace(/\\/g, "/");
	for (const rawPart of normalizedInput.split("/")) {
		const part = rawPart.trim();
		if (!part || part === ".") {
			continue;
		}
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `/${parts.join("/")}`;
}

function is_valid_tmp_path(path: string) {
	return path !== "/" && path.startsWith("/") && path === normalize_path(path) && !path.startsWith("/tmp/");
}

async function require_thread_scope(
	ctx: QueryCtx | MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		threadId: Id<"ai_chat_threads">;
	},
) {
	const thread = await ctx.db.get("ai_chat_threads", args.threadId);
	if (!thread) {
		throw convex_error({ message: "Not found" });
	}
	if (thread.workspaceId !== args.workspaceId || thread.projectId !== args.projectId) {
		throw convex_error({ message: "Unauthorized" });
	}
	return thread;
}

function validate_tmp_entries_and_contents(args: { entries: TmpEntryInput[]; contents: TmpContentInput[] }) {
	if (args.entries.length > AI_CHAT_TMP_MAX_PATHS) {
		return Result({ _nay: { message: "/tmp path limit exceeded" } });
	}

	const contentByPath = new Map(args.contents.map((content) => [content.path, content.bytes]));
	const entryPaths = new Set<string>();
	const filePaths = new Set<string>();
	let totalBytes = 0;
	for (const entry of args.entries) {
		if (!is_valid_tmp_path(entry.path)) {
			return Result({ _nay: { message: `Invalid /tmp path: ${entry.path}` } });
		}
		if (entryPaths.has(entry.path)) {
			return Result({ _nay: { message: `Duplicate /tmp path: ${entry.path}` } });
		}
		entryPaths.add(entry.path);

		if (entry.kind === "file") {
			filePaths.add(entry.path);
			const bytes = contentByPath.get(entry.path);
			if (!bytes) {
				return Result({ _nay: { message: `Missing /tmp file content: ${entry.path}` } });
			}
			if (bytes.byteLength > AI_CHAT_TMP_FILE_MAX_BYTES) {
				return Result({ _nay: { message: `/tmp file is too large: ${entry.path}` } });
			}
			totalBytes += bytes.byteLength;
		} else if (entry.kind === "symlink") {
			totalBytes += textEncoder.encode(entry.symlinkTargetPath ?? "").length;
		}
	}

	for (const content of args.contents) {
		if (!filePaths.has(content.path)) {
			return Result({ _nay: { message: `Unexpected /tmp file content: ${content.path}` } });
		}
	}

	if (totalBytes > AI_CHAT_TMP_MAX_BYTES) {
		return Result({ _nay: { message: "/tmp byte limit exceeded" } });
	}

	return Result({ _yay: { contentByPath, entryPaths, filePaths, totalBytes } });
}

async function flush_thread_tmp_files_impl(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		threadId: Id<"ai_chat_threads">;
		entries: TmpEntryInput[];
		contents: TmpContentInput[];
	},
) {
	await require_thread_scope(ctx, args);

	const validated = validate_tmp_entries_and_contents(args);
	if (validated._nay) {
		return validated;
	}
	const contentByPath = validated._yay.contentByPath;

	const now = Date.now();
	const existingAiChatFiles = await ctx.db
		.query("ai_chat_files")
		.withIndex("by_thread_path", (q) => q.eq("threadId", args.threadId))
		.take(AI_CHAT_TMP_MAX_PATHS + 1);
	const existingByPath = new Map(existingAiChatFiles.map((entry) => [entry.path, entry]));
	const nextFileNodeIdByPath = new Map<string, Id<"ai_chat_files">>();

	for (const existing of existingAiChatFiles) {
		if (!validated._yay.entryPaths.has(existing.path)) {
			const aiChatFilesContent = await ctx.db
				.query("ai_chat_files_content")
				.withIndex("by_file", (q) => q.eq("fileNodeId", existing._id))
				.collect();
			await Promise.all(aiChatFilesContent.map((row) => ctx.db.delete("ai_chat_files_content", row._id)));
			await ctx.db.delete("ai_chat_files", existing._id);
		}
	}

	for (const entry of args.entries) {
		const bytes = contentByPath.get(entry.path);
		const size =
			entry.kind === "file"
				? (bytes?.byteLength ?? 0)
				: entry.kind === "symlink"
					? textEncoder.encode(entry.symlinkTargetPath ?? "").length
					: 0;
		const doc = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: args.threadId,
			path: entry.path,
			kind: entry.kind,
			mode: entry.mode,
			size,
			mtime: entry.mtime,
			...(entry.kind === "symlink" && entry.symlinkTargetPath !== undefined
				? { symlinkTargetPath: entry.symlinkTargetPath }
				: {}),
		};
		const existing = existingByPath.get(entry.path);
		const fileNodeId = existing?._id ?? (await ctx.db.insert("ai_chat_files", doc));
		if (existing) {
			await ctx.db.replace("ai_chat_files", existing._id, doc);
		}

		if (entry.kind === "file") {
			nextFileNodeIdByPath.set(entry.path, fileNodeId);
		} else if (existing) {
			const aiChatFilesContent = await ctx.db
				.query("ai_chat_files_content")
				.withIndex("by_file", (q) => q.eq("fileNodeId", existing._id))
				.collect();
			await Promise.all(aiChatFilesContent.map((row) => ctx.db.delete("ai_chat_files_content", row._id)));
		}
	}

	for (const [path, bytes] of contentByPath) {
		const fileNodeId = nextFileNodeIdByPath.get(path);
		if (!fileNodeId) {
			continue;
		}
		const existingAiChatFilesContent = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_file", (q) => q.eq("fileNodeId", fileNodeId))
			.first();
		const doc = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: args.threadId,
			fileNodeId,
			bytes,
		};
		if (existingAiChatFilesContent) {
			await ctx.db.replace("ai_chat_files_content", existingAiChatFilesContent._id, doc);
		} else {
			await ctx.db.insert("ai_chat_files_content", doc);
		}
	}

	const state = await ctx.db
		.query("ai_chat_files_state")
		.withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
		.first();
	const stateDoc = {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		threadId: args.threadId,
		pathCount: args.entries.length,
		totalBytes: validated._yay.totalBytes,
		updatedAt: now,
	};
	if (state) {
		await ctx.db.replace("ai_chat_files_state", state._id, stateDoc);
	} else {
		await ctx.db.insert("ai_chat_files_state", stateDoc);
	}

	return Result({ _yay: { pathCount: args.entries.length, totalBytes: validated._yay.totalBytes } });
}

export const load_thread_tmp_files = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		threadId: v.id("ai_chat_threads"),
	},
	returns: v.object({
		aiChatFiles: v.array(doc(app_convex_schema, "ai_chat_files")),
		aiChatFilesContentDict: v.record(v.id("ai_chat_files"), doc(app_convex_schema, "ai_chat_files_content")),
		aiChatFilesState: v.union(doc(app_convex_schema, "ai_chat_files_state"), v.null()),
	}),
	handler: async (ctx, args) => {
		await require_thread_scope(ctx, args);

		const aiChatFilesState = await ctx.db
			.query("ai_chat_files_state")
			.withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
			.first();
		if (!aiChatFilesState) {
			return {
				aiChatFiles: [],
				aiChatFilesContentDict: {} as Record<Id<"ai_chat_files">, Doc<"ai_chat_files_content">>,
				aiChatFilesState: null,
			};
		}

		const aiChatFiles = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.threadId))
			.take(AI_CHAT_TMP_MAX_PATHS + 1);
		const aiChatFilesContent = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_thread_file", (q) => q.eq("threadId", args.threadId))
			.take(AI_CHAT_TMP_MAX_PATHS + 1);
		const aiChatFilesContentDict: Record<Id<"ai_chat_files">, Doc<"ai_chat_files_content">> = {};
		for (const content of aiChatFilesContent) {
			aiChatFilesContentDict[content.fileNodeId] = content;
		}

		return { aiChatFiles, aiChatFilesContentDict, aiChatFilesState };
	},
});

export type ai_chat_files_load_thread_tmp_files_Result =
	typeof load_thread_tmp_files extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const flush_thread_tmp_files = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		threadId: v.id("ai_chat_threads"),
		entries: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("file"), v.literal("directory"), v.literal("symlink")),
				mode: v.number(),
				size: v.number(),
				mtime: v.number(),
				symlinkTargetPath: v.optional(v.string()),
			}),
		),
		contents: v.array(
			v.object({
				path: v.string(),
				bytes: v.bytes(),
			}),
		),
	},
	returns: v_result({
		_yay: v.object({
			pathCount: v.number(),
			totalBytes: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		return await flush_thread_tmp_files_impl(ctx, args);
	},
});

export type ai_chat_files_flush_thread_tmp_files_Result =
	typeof flush_thread_tmp_files extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export type ai_chat_files_flush_thread_tmp_files_Args =
	typeof flush_thread_tmp_files extends RegisteredMutation<infer _Visibility, infer Args, infer _ReturnValue>
		? Args
		: never;

export const patch_thread_tmp_files = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		threadId: v.id("ai_chat_threads"),
		upsertEntries: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("file"), v.literal("directory"), v.literal("symlink")),
				mode: v.number(),
				size: v.number(),
				mtime: v.number(),
				symlinkTargetPath: v.optional(v.string()),
			}),
		),
		upsertContents: v.array(
			v.object({
				path: v.string(),
				bytes: v.bytes(),
			}),
		),
		deletePaths: v.array(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			pathCount: v.number(),
			totalBytes: v.number(),
			upsertedPathCount: v.number(),
			deletedPathCount: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		await require_thread_scope(ctx, args);

		const deletePathSet = new Set<string>();
		for (const path of args.deletePaths) {
			if (!is_valid_tmp_path(path)) {
				return Result({ _nay: { message: `Invalid /tmp path: ${path}` } });
			}
			if (deletePathSet.has(path)) {
				return Result({ _nay: { message: `Duplicate /tmp delete path: ${path}` } });
			}
			deletePathSet.add(path);
		}

		const validated = validate_tmp_entries_and_contents({
			entries: args.upsertEntries,
			contents: args.upsertContents,
		});
		if (validated._nay) {
			return validated;
		}
		for (const entry of args.upsertEntries) {
			if (deletePathSet.has(entry.path)) {
				return Result({ _nay: { message: `Conflicting /tmp patch path: ${entry.path}` } });
			}
		}

		const now = Date.now();
		const existingAiChatFiles = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.threadId))
			.take(AI_CHAT_TMP_MAX_PATHS + 1);
		const existingByPath = new Map(existingAiChatFiles.map((entry) => [entry.path, entry]));
		const nextEntries = new Map(
			existingAiChatFiles.map((entry) => [
				entry.path,
				{
					kind: entry.kind,
					size: entry.size,
				},
			]),
		);

		for (const path of deletePathSet) {
			nextEntries.delete(path);
		}
		for (const entry of args.upsertEntries) {
			const bytes = validated._yay.contentByPath.get(entry.path);
			const size =
				entry.kind === "file"
					? (bytes?.byteLength ?? 0)
					: entry.kind === "symlink"
						? textEncoder.encode(entry.symlinkTargetPath ?? "").length
						: 0;
			nextEntries.set(entry.path, { kind: entry.kind, size });
		}

		const pathCount = nextEntries.size;
		if (pathCount > AI_CHAT_TMP_MAX_PATHS) {
			return Result({ _nay: { message: "/tmp path limit exceeded" } });
		}
		let totalBytes = 0;
		for (const entry of nextEntries.values()) {
			if (entry.kind === "file" || entry.kind === "symlink") {
				totalBytes += entry.size;
			}
		}
		if (totalBytes > AI_CHAT_TMP_MAX_BYTES) {
			return Result({ _nay: { message: "/tmp byte limit exceeded" } });
		}

		for (const path of deletePathSet) {
			const existing = existingByPath.get(path);
			if (!existing) {
				continue;
			}
			const aiChatFilesContent = await ctx.db
				.query("ai_chat_files_content")
				.withIndex("by_file", (q) => q.eq("fileNodeId", existing._id))
				.collect();
			await Promise.all(aiChatFilesContent.map((row) => ctx.db.delete("ai_chat_files_content", row._id)));
			await ctx.db.delete("ai_chat_files", existing._id);
		}

		const fileNodeIdByPath = new Map<string, Id<"ai_chat_files">>();
		for (const entry of args.upsertEntries) {
			const bytes = validated._yay.contentByPath.get(entry.path);
			const size =
				entry.kind === "file"
					? (bytes?.byteLength ?? 0)
					: entry.kind === "symlink"
						? textEncoder.encode(entry.symlinkTargetPath ?? "").length
						: 0;
			const doc = {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				threadId: args.threadId,
				path: entry.path,
				kind: entry.kind,
				mode: entry.mode,
				size,
				mtime: entry.mtime,
				...(entry.kind === "symlink" && entry.symlinkTargetPath !== undefined
					? { symlinkTargetPath: entry.symlinkTargetPath }
					: {}),
			};
			const existing = existingByPath.get(entry.path);
			const fileNodeId = existing?._id ?? (await ctx.db.insert("ai_chat_files", doc));
			if (existing) {
				await ctx.db.replace("ai_chat_files", existing._id, doc);
			}

			if (entry.kind === "file") {
				fileNodeIdByPath.set(entry.path, fileNodeId);
			} else if (existing) {
				const aiChatFilesContent = await ctx.db
					.query("ai_chat_files_content")
					.withIndex("by_file", (q) => q.eq("fileNodeId", existing._id))
					.collect();
				await Promise.all(aiChatFilesContent.map((row) => ctx.db.delete("ai_chat_files_content", row._id)));
			}
		}

		for (const [path, bytes] of validated._yay.contentByPath) {
			const fileNodeId = fileNodeIdByPath.get(path);
			if (!fileNodeId) {
				continue;
			}
			const existingAiChatFilesContent = await ctx.db
				.query("ai_chat_files_content")
				.withIndex("by_file", (q) => q.eq("fileNodeId", fileNodeId))
				.first();
			const doc = {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				threadId: args.threadId,
				fileNodeId,
				bytes,
			};
			if (existingAiChatFilesContent) {
				await ctx.db.replace("ai_chat_files_content", existingAiChatFilesContent._id, doc);
			} else {
				await ctx.db.insert("ai_chat_files_content", doc);
			}
		}

		const state = await ctx.db
			.query("ai_chat_files_state")
			.withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
			.first();
		const stateDoc = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: args.threadId,
			pathCount,
			totalBytes,
			updatedAt: now,
		};
		if (state) {
			await ctx.db.replace("ai_chat_files_state", state._id, stateDoc);
		} else {
			await ctx.db.insert("ai_chat_files_state", stateDoc);
		}

		return Result({
			_yay: {
				pathCount,
				totalBytes,
				upsertedPathCount: args.upsertEntries.length,
				deletedPathCount: deletePathSet.size,
			},
		});
	},
});

export type ai_chat_files_patch_thread_tmp_files_Result =
	typeof patch_thread_tmp_files extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const copy_thread_tmp_files = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		sourceThreadId: v.id("ai_chat_threads"),
		targetThreadId: v.id("ai_chat_threads"),
	},
	returns: v_result({
		_yay: v.object({
			pathCount: v.number(),
			totalBytes: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		await require_thread_scope(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: args.sourceThreadId,
		});
		await require_thread_scope(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: args.targetThreadId,
		});

		const sourceAiChatFiles = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.sourceThreadId))
			.take(AI_CHAT_TMP_MAX_PATHS + 1);
		const pathByFileNodeId = new Map(sourceAiChatFiles.map((entry) => [entry._id, entry.path]));
		const sourceAiChatFilesContent = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_thread_file", (q) => q.eq("threadId", args.sourceThreadId))
			.take(AI_CHAT_TMP_MAX_PATHS + 1);

		return await flush_thread_tmp_files_impl(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: args.targetThreadId,
			entries: sourceAiChatFiles.map((entry) => ({
				path: entry.path,
				kind: entry.kind,
				mode: entry.mode,
				size: entry.size,
				mtime: entry.mtime,
				...(entry.symlinkTargetPath !== undefined ? { symlinkTargetPath: entry.symlinkTargetPath } : {}),
			})),
			contents: sourceAiChatFilesContent.flatMap((content) => {
				const path = pathByFileNodeId.get(content.fileNodeId);
				return path ? [{ path, bytes: content.bytes }] : [];
			}),
		});
	},
});
