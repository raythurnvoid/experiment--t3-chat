import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel";
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
	target?: string;
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

async function read_thread_entries(ctx: QueryCtx | MutationCtx, threadId: Id<"ai_chat_threads">) {
	return await ctx.db
		.query("ai_chat_files")
		.withIndex("by_thread", (q) => q.eq("threadId", threadId))
		.take(AI_CHAT_TMP_MAX_PATHS + 1);
}

async function delete_content_rows_for_file(ctx: MutationCtx, fileId: Id<"ai_chat_files">) {
	const rows = await ctx.db
		.query("ai_chat_files_content")
		.withIndex("by_file", (q) => q.eq("fileId", fileId))
		.collect();
	await Promise.all(rows.map((row) => ctx.db.delete("ai_chat_files_content", row._id)));
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
			totalBytes += textEncoder.encode(entry.target ?? "").length;
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
		userId: Id<"users">;
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
	const existingEntries = await read_thread_entries(ctx, args.threadId);
	const existingByPath = new Map(existingEntries.map((entry) => [entry.path, entry]));
	const nextFileIdsByPath = new Map<string, Id<"ai_chat_files">>();

	for (const existing of existingEntries) {
		if (!validated._yay.entryPaths.has(existing.path)) {
			await delete_content_rows_for_file(ctx, existing._id);
			await ctx.db.delete("ai_chat_files", existing._id);
		}
	}

	for (const entry of args.entries) {
		const bytes = contentByPath.get(entry.path);
		const size =
			entry.kind === "file"
				? (bytes?.byteLength ?? 0)
				: entry.kind === "symlink"
					? textEncoder.encode(entry.target ?? "").length
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
			...(entry.kind === "symlink" && entry.target !== undefined ? { target: entry.target } : {}),
			updatedBy: args.userId,
			updatedAt: now,
		};
		const existing = existingByPath.get(entry.path);
		const fileId = existing?._id ?? (await ctx.db.insert("ai_chat_files", doc));
		if (existing) {
			await ctx.db.replace("ai_chat_files", existing._id, doc);
		}

		if (entry.kind === "file") {
			nextFileIdsByPath.set(entry.path, fileId);
		} else if (existing) {
			await delete_content_rows_for_file(ctx, existing._id);
		}
	}

	for (const [path, bytes] of contentByPath) {
		const fileId = nextFileIdsByPath.get(path);
		if (!fileId) {
			continue;
		}
		const existingContent = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_file", (q) => q.eq("fileId", fileId))
			.first();
		const doc = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: args.threadId,
			fileId,
			bytes,
			updatedAt: now,
		};
		if (existingContent) {
			await ctx.db.replace("ai_chat_files_content", existingContent._id, doc);
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
		updatedBy: args.userId,
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
		entries: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("file"), v.literal("directory"), v.literal("symlink")),
				mode: v.number(),
				size: v.number(),
				mtime: v.number(),
				target: v.optional(v.string()),
			}),
		),
		contents: v.array(
			v.object({
				path: v.string(),
				bytes: v.bytes(),
			}),
		),
		pathCount: v.number(),
		totalBytes: v.number(),
	}),
	handler: async (ctx, args) => {
		await require_thread_scope(ctx, args);

		const state = await ctx.db
			.query("ai_chat_files_state")
			.withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
			.first();
		if (!state) {
			return {
				entries: [],
				contents: [],
				pathCount: 0,
				totalBytes: 0,
			};
		}

		const entries = await read_thread_entries(ctx, args.threadId);
		const fileIds = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry._id));
		const pathByFileId = new Map(entries.map((entry) => [entry._id, entry.path]));
		const contentRows = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
			.take(AI_CHAT_TMP_MAX_PATHS + 1);

		return {
			entries: entries.map((entry) => ({
				path: entry.path,
				kind: entry.kind,
				mode: entry.mode,
				size: entry.size,
				mtime: entry.mtime,
				...(entry.target !== undefined ? { target: entry.target } : {}),
			})),
			contents: contentRows.flatMap((row) => {
				if (!fileIds.has(row.fileId)) {
					return [];
				}
				const path = pathByFileId.get(row.fileId);
				return path ? [{ path, bytes: row.bytes }] : [];
			}),
			pathCount: state.pathCount,
			totalBytes: state.totalBytes,
		};
	},
});

export const flush_thread_tmp_files = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		threadId: v.id("ai_chat_threads"),
		userId: v.id("users"),
		entries: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("file"), v.literal("directory"), v.literal("symlink")),
				mode: v.number(),
				size: v.number(),
				mtime: v.number(),
				target: v.optional(v.string()),
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

export const patch_thread_tmp_files = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		threadId: v.id("ai_chat_threads"),
		userId: v.id("users"),
		upsertEntries: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("file"), v.literal("directory"), v.literal("symlink")),
				mode: v.number(),
				size: v.number(),
				mtime: v.number(),
				target: v.optional(v.string()),
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
		const existingEntries = await read_thread_entries(ctx, args.threadId);
		const existingByPath = new Map(existingEntries.map((entry) => [entry.path, entry]));
		const nextEntries = new Map(
			existingEntries.map((entry) => [
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
						? textEncoder.encode(entry.target ?? "").length
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
			await delete_content_rows_for_file(ctx, existing._id);
			await ctx.db.delete("ai_chat_files", existing._id);
		}

		const fileIdsByPath = new Map<string, Id<"ai_chat_files">>();
		for (const entry of args.upsertEntries) {
			const bytes = validated._yay.contentByPath.get(entry.path);
			const size =
				entry.kind === "file"
					? (bytes?.byteLength ?? 0)
					: entry.kind === "symlink"
						? textEncoder.encode(entry.target ?? "").length
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
				...(entry.kind === "symlink" && entry.target !== undefined ? { target: entry.target } : {}),
				updatedBy: args.userId,
				updatedAt: now,
			};
			const existing = existingByPath.get(entry.path);
			const fileId = existing?._id ?? (await ctx.db.insert("ai_chat_files", doc));
			if (existing) {
				await ctx.db.replace("ai_chat_files", existing._id, doc);
			}

			if (entry.kind === "file") {
				fileIdsByPath.set(entry.path, fileId);
			} else if (existing) {
				await delete_content_rows_for_file(ctx, existing._id);
			}
		}

		for (const [path, bytes] of validated._yay.contentByPath) {
			const fileId = fileIdsByPath.get(path);
			if (!fileId) {
				continue;
			}
			const existingContent = await ctx.db
				.query("ai_chat_files_content")
				.withIndex("by_file", (q) => q.eq("fileId", fileId))
				.first();
			const doc = {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				threadId: args.threadId,
				fileId,
				bytes,
				updatedAt: now,
			};
			if (existingContent) {
				await ctx.db.replace("ai_chat_files_content", existingContent._id, doc);
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
			updatedBy: args.userId,
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

export const copy_thread_tmp_files = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		sourceThreadId: v.id("ai_chat_threads"),
		targetThreadId: v.id("ai_chat_threads"),
		userId: v.id("users"),
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

		const sourceEntries = await read_thread_entries(ctx, args.sourceThreadId);
		const pathByFileId = new Map(sourceEntries.map((entry) => [entry._id, entry.path]));
		const sourceContents = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_thread", (q) => q.eq("threadId", args.sourceThreadId))
			.take(AI_CHAT_TMP_MAX_PATHS + 1);

		return await flush_thread_tmp_files_impl(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: args.targetThreadId,
			userId: args.userId,
			entries: sourceEntries.map((entry) => ({
				path: entry.path,
				kind: entry.kind,
				mode: entry.mode,
				size: entry.size,
				mtime: entry.mtime,
				...(entry.target !== undefined ? { target: entry.target } : {}),
			})),
			contents: sourceContents.flatMap((content) => {
				const path = pathByFileId.get(content.fileId);
				return path ? [{ path, bytes: content.bytes }] : [];
			}),
		});
	},
});
