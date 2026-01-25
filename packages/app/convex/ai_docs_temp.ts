/*
Pages are organized in a emulated file system in which each page exists in a tree and each page can have children.

This structure allows file system like operations such has finding all items under a certain path (`foo/bar/*`) or
listing all children or the content of a certain page (`foo/bar/baz`).
*/

import {
	httpAction,
	internalQuery,
	mutation,
	query,
	type QueryCtx,
	type MutationCtx,
	type ActionCtx,
	internalMutation,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator, type RouteSpec } from "convex/server";
import { streamText, smoothStream } from "ai";
import { openai } from "@ai-sdk/openai";
import {
	server_path_extract_segments_from,
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
	encode_path_segment,
} from "../server/server-utils.ts";
import { v, type Infer } from "convex/values";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import {
	date_get_week_start_timestamp,
	date_get_day_start_timestamp,
	date_get_hour_start_timestamp,
	date_MS_DAY,
	date_MS_DAYS_30,
	date_MS_WEEK,
} from "../shared/date.ts";
import {
	pages_FIRST_VERSION,
	pages_ROOT_ID,
	pages_headless_tiptap_editor_create,
	pages_u8_to_array_buffer,
	pages_headless_tiptap_editor_set_content_from_markdown,
	pages_yjs_create_empty_state_update,
	pages_yjs_doc_create_from_array_buffer_update,
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_update_from_tiptap_editor,
	pages_yjs_doc_create_from_tiptap_editor,
	pages_yjs_compute_diff_update_from_state_vector,
} from "../server/pages.ts";
import { minimatch } from "minimatch";
import { Result } from "../shared/errors-as-values-utils.ts";
import { encodeStateVector, encodeStateAsUpdate, mergeUpdates } from "yjs";
import type { Editor } from "@tiptap/core";
import { generate_id, should_never_happen } from "../shared/shared-utils.ts";
import app_convex_schema from "./schema.ts";
import { internal } from "./_generated/api.js";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import type { RouterForConvexModules } from "./http.ts";

async function resolve_id_from_path(ctx: QueryCtx, args: { workspace_id: string; project_id: string; path: string }) {
	if (args.path === "/") return null;

	const segments = server_path_extract_segments_from(args.path);

	let pageId = null;
	let currentNode = pages_ROOT_ID;

	for (const segment of segments) {
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_parent_id_and_name", (q) =>
				q
					.eq("workspace_id", args.workspace_id)
					.eq("project_id", args.project_id)
					.eq("parent_id", currentNode)
					.eq("name", segment),
			)
			.unique();

		if (!page) return null;
		currentNode = page.page_id;
		pageId = page._id;
	}

	return pageId;
}

async function resolve_page_id_from_path_fn(
	ctx: QueryCtx,
	args: { workspaceId: string; projectId: string; path: string },
) {
	const segments = server_path_extract_segments_from(args.path);

	let pageId = null;
	let currentNode = pages_ROOT_ID;

	for (const segment of segments) {
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_parent_id_and_name", (q) =>
				q
					.eq("workspace_id", args.workspaceId)
					.eq("project_id", args.projectId)
					.eq("parent_id", currentNode)
					.eq("name", segment),
			)
			.unique();
		if (!page) return null;
		currentNode = page.page_id;
		pageId = page._id;
	}

	return pageId;
}

export const resolve_page_id_from_path = internalQuery({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: (ctx, args) => resolve_page_id_from_path_fn(ctx, args),
});

async function resolve_tree_node_id_from_path_fn(
	ctx: QueryCtx,
	args: { workspaceId: string; projectId: string; path: string },
) {
	if (args.path === "/") return pages_ROOT_ID;
	const segments = server_path_extract_segments_from(args.path);

	let currentNode = pages_ROOT_ID;

	for (const segment of segments) {
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_parent_id_and_name", (q) =>
				q
					.eq("workspace_id", args.workspaceId)
					.eq("project_id", args.projectId)
					.eq("parent_id", currentNode)
					.eq("name", segment),
			)
			.unique();
		if (!page) return null;
		currentNode = page.page_id;
	}

	return currentNode;
}

export const resolve_tree_node_id_from_path = internalQuery({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: (ctx, args) => resolve_tree_node_id_from_path_fn(ctx, args),
});

async function resolve_path_from_page_id(
	ctx: QueryCtx,
	args: { workspace_id: string; project_id: string; page_id: string },
): Promise<string> {
	if (args.page_id === pages_ROOT_ID) return "/";
	const segments: string[] = [];
	let currentId: string | null = args.page_id;
	while (currentId && currentId !== pages_ROOT_ID) {
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q
					.eq("workspace_id", args.workspace_id)
					.eq("project_id", args.project_id)
					.eq("page_id", currentId as string),
			)
			.first();
		if (!page) break;
		segments.unshift(page.name);
		currentId = page.parent_id;
	}
	return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

const get_tree_items_list_validator = v.array(
	v.object({
		type: v.union(v.literal("root"), v.literal("page"), v.literal("placeholder")),
		index: v.string(),
		parentId: v.string(),
		title: v.string(),
		isArchived: v.boolean(),
		updatedAt: v.number(),
		updatedBy: v.string(),
		_id: v.union(v.id("pages"), v.null()),
	}),
);

export type pages_TreeItem = Infer<typeof get_tree_items_list_validator>[number];

export const get_tree_items_list = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: get_tree_items_list_validator,
	handler: async (ctx, args) => {
		const pages = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_name", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId),
			)
			.order("asc")
			.filter((q) => q.and(q.neq(q.field("page_id"), ""), q.neq(q.field("name"), "")))
			.collect();

		const treeItemsList: pages_TreeItem[] = [
			{
				type: "root",
				index: pages_ROOT_ID,
				parentId: "",
				title: "Pages",
				isArchived: false,
				updatedAt: Date.now(),
				updatedBy: "system",
				_id: null,
			},
			...pages.map(
				(page) =>
					({
						type: "page" as const,
						index: page.page_id,
						parentId: page.parent_id,
						title: page.name || "Untitled",
						isArchived: page.is_archived,
						updatedAt: page.updated_at,
						updatedBy: page.updated_by,
						_id: page._id,
					}) satisfies pages_TreeItem,
			),
		];

		return treeItemsList;
	},
});

async function do_create_page(
	ctx: MutationCtx,
	args: {
		workspace_id: Doc<"pages">["workspace_id"];
		project_id: Doc<"pages">["project_id"];
		page_id: Doc<"pages">["page_id"];
		parent_id: Doc<"pages">["page_id"];
		name: Doc<"pages">["name"];
		markdown_content: Doc<"pages_markdown_content">["content"];
	},
) {
	const user = await server_convex_get_user_fallback_to_anonymous(ctx);
	const now = Date.now();

	const initialIsArchived = false;

	const pageId = await ctx.db.insert("pages", {
		workspace_id: args.workspace_id,
		project_id: args.project_id,
		page_id: args.page_id,
		parent_id: args.parent_id,
		version: pages_FIRST_VERSION,
		name: args.name,
		is_archived: initialIsArchived,
		created_by: user.name,
		updated_by: user.name,
		updated_at: now,
	});

	// Create initial Yjs snapshot + sequence tracker with the page.
	// Important: do NOT store an empty bytes blob; Yjs update decoding may throw on empty payloads.
	const initialYjsSequence = 0;

	let initialYjsSnapshotUpdate;
	if (args.markdown_content) {
		const editor = pages_headless_tiptap_editor_create();
		pages_headless_tiptap_editor_set_content_from_markdown({
			markdown: args.markdown_content ?? "",
			mut_editor: editor,
		});
		initialYjsSnapshotUpdate = yjs_create_state_update_from_tiptap_editor({
			tiptapEditor: editor,
		});
	} else {
		initialYjsSnapshotUpdate = pages_yjs_create_empty_state_update();
	}

	const [yjs_snapshot_id, yjs_last_sequence_id, markdown_content_id] = await Promise.all([
		ctx.db.insert("pages_yjs_snapshots", {
			workspace_id: args.workspace_id,
			project_id: args.project_id,
			page_id: pageId,
			sequence: initialYjsSequence,
			snapshot_update: pages_u8_to_array_buffer(initialYjsSnapshotUpdate),
			created_by: user.name,
			updated_by: user.name,
			updated_at: now,
		}),
		ctx.db.insert("pages_yjs_docs_last_sequences", {
			workspace_id: args.workspace_id,
			project_id: args.project_id,
			page_id: pageId,
			last_sequence: initialYjsSequence,
		}),
		ctx.db.insert("pages_markdown_content", {
			workspace_id: args.workspace_id,
			project_id: args.project_id,
			page_id: pageId,
			content: args.markdown_content,
			is_archived: initialIsArchived,
			yjs_sequence: initialYjsSequence,
			updated_by: user.name,
			updated_at: now,
		}),
	]);

	await ctx.db.patch("pages", pageId, {
		markdown_content_id: markdown_content_id,
		yjs_last_sequence_id: yjs_last_sequence_id,
		yjs_snapshot_id: yjs_snapshot_id,
	});

	return pageId;
}

export const create_page = mutation({
	args: {
		pageId: v.string(),
		parentId: v.string(),
		name: v.string(),
		workspaceId: v.string(),
		projectId: v.string(),
	},
	handler: async (ctx, args) => {
		await do_create_page(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
			parent_id: args.parentId,
			name: args.name,
			markdown_content: "",
		});
	},
});

export const get_page_id_from_client_generated_id = query({
	args: { workspaceId: v.string(), projectId: v.string(), clientGeneratedId: v.string() },
	returns: v.union(v.id("pages"), v.null()),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.clientGeneratedId),
			)
			.first();
		return page?._id ?? null;
	},
});

export const create_page_quick = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: v.object({ page_id: v.id("pages") }),
	handler: async (ctx, args) => {
		const { workspaceId, projectId } = args;

		// Ensure ".tmp" under root exists
		const tmp = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_parent_id_and_name", (q) =>
				q.eq("workspace_id", workspaceId).eq("project_id", projectId).eq("parent_id", pages_ROOT_ID).eq("name", ".tmp"),
			)
			.first();

		let tmpPageId = null;

		if (!tmp) {
			tmpPageId = await do_create_page(ctx, {
				workspace_id: workspaceId,
				project_id: projectId,
				page_id: `.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
				parent_id: pages_ROOT_ID,
				name: ".tmp",
				markdown_content:
					"Automatically generated temp folder\n\nThis page contains temporary pages generated by the system.",
			});
		} else {
			tmpPageId = tmp._id;
		}

		// Create quick page under ".tmp"
		const title = `Quick page created at ${new Date().toLocaleString("en-GB", { hour12: false })}`;
		const pageId = await do_create_page(ctx, {
			workspace_id: workspaceId,
			project_id: projectId,
			page_id: generate_id("page"),
			parent_id: tmpPageId,
			name: title,
			markdown_content: "",
		});

		return { page_id: pageId };
	},
});

export const rename_page = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
		name: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		// Check if this is the homepage (path "/") and ignore if so
		const path = await resolve_path_from_page_id(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
		});

		if (path === "/") {
			// Ignore rename requests for homepage
			return;
		}

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.first();

		if (page) {
			await ctx.db.patch("pages", page._id, {
				name: args.name,
				updated_by: user.name,
				updated_at: Date.now(),
			});
		}
	},
});

export const move_pages = mutation({
	args: {
		itemIds: v.array(v.string()),
		targetParentId: v.string(),
		workspaceId: v.string(),
		projectId: v.string(),
	},
	handler: async (ctx, args) => {
		for (const item_id of args.itemIds) {
			// Check if this is the homepage (path "/") and skip if so
			const path = await resolve_path_from_page_id(ctx, {
				workspace_id: args.workspaceId,
				project_id: args.projectId,
				page_id: item_id,
			});

			if (path === "/") {
				// Skip move requests for homepage
				continue;
			}

			const page = await ctx.db
				.query("pages")
				.withIndex("by_workspace_project_and_page_id", (q) =>
					q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", item_id),
				)
				.first();

			if (page) {
				await ctx.db.patch("pages", page._id, {
					workspace_id: args.workspaceId,
					project_id: args.projectId,
					parent_id: args.targetParentId,
					updated_at: Date.now(),
				});
			}
		}
	},
});

export const archive_pages = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		// Check if this is the homepage (path "/") and ignore if so
		const path = await resolve_path_from_page_id(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
		});

		if (path === "/") {
			// Ignore archive requests for homepage
			return;
		}

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.first();

		if (page) {
			await ctx.db.patch("pages", page._id, {
				is_archived: true,
				updated_by: user.name,
				updated_at: Date.now(),
			});
		}
	},
});

export const unarchive_pages = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		// Check if this is the homepage (path "/") and ignore if so
		const path = await resolve_path_from_page_id(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
		});

		if (path === "/") {
			// Ignore unarchive requests for homepage
			return;
		}

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.first();

		if (page) {
			await ctx.db.patch("pages", page._id, {
				is_archived: false,
				updated_by: user.name,
				updated_at: Date.now(),
			});
		}
	},
});

export const get_page_by_path = query({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.union(
		v.object({
			workspace_id: v.union(v.string(), v.null()),
			project_id: v.union(v.string(), v.null()),
			page_id: v.id("pages"),
			name: v.string(),
			is_archived: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const pageId = await resolve_id_from_path(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			path: args.path,
		});

		if (!pageId) return null;

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", pageId),
			)
			.first();

		return page
			? {
					workspace_id: page.workspace_id,
					project_id: page.project_id,
					page_id: page._id,
					name: page.name,
					is_archived: page.is_archived,
				}
			: null;
	},
});

export const read_dir = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
	},
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		const nodeId = await resolve_tree_node_id_from_path_fn(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
		if (!nodeId) return [];

		const children = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_parent_id_and_is_archived", (q) =>
				q
					.eq("workspace_id", args.workspaceId)
					.eq("project_id", args.projectId)
					.eq("parent_id", nodeId)
					.eq("is_archived", false),
			)
			.collect();

		// TODO: do not collect
		const names = children.map((page) => page.name);
		return names;
	},
});

export const get_page_info_for_list_dir_pagination = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		parentId: v.string(),
		cursor: paginationOptsValidator.fields.cursor,
	},
	handler: async (ctx, args) => {
		// TODO: do not use paginate
		const result = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_parent_id_and_is_archived", (q) =>
				q
					.eq("workspace_id", args.workspaceId)
					.eq("project_id", args.projectId)
					.eq("parent_id", args.parentId)
					.eq("is_archived", false),
			)
			.paginate({
				cursor: args.cursor,
				numItems: 1,
			});

		return {
			...result,
			page: result.page.map((page) => ({
				name: page.name,
				page_id: page.page_id,
				updated_at: page.updated_at,
			})),
		};
	},
});

export const list_pages = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		maxDepth: v.number(),
		limit: v.number(),
		include: v.optional(v.string()),
	},
	returns: v.object({
		items: v.array(v.object({ path: v.string(), updatedAt: v.number(), depthTruncated: v.boolean() })),
		truncated: v.boolean(),
	}),
	handler: async (ctx, args) => {
		// TODO: when truncating, we truncate the total rows but we don't tell the LLM if we truncated in depth
		const startNodeId = await resolve_tree_node_id_from_path_fn(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
		if (!startNodeId) return { items: [], truncated: false };

		// Normalize base path to an absolute path string (leading slash, no trailing slash except root)
		const basePath = args.path;
		const maxDepth = Math.max(0, Math.min(10, args.maxDepth));
		const limit = Math.max(1, Math.min(100, args.limit));
		const include = args.include;

		const matchesInclude = (absPath: string) => (include ? minimatch(absPath, include) : true);

		const results: Array<{ path: string; updatedAt: number; depthTruncated: boolean }> = [];
		let truncated = false;

		// Depth-first traversal using an explicit stack.
		// We iterate children via an indexed query (async iterable) and dive deeper first.
		const stack: Array<{
			parentId: string;
			absPath: string;
			depth: number;
			iterator: AsyncIterator<Doc<"pages">> | null;
		}> = [{ parentId: startNodeId, absPath: basePath, depth: 0, iterator: null }];

		try {
			// Iterate 1 extra time (less or equal `limit`) to flag the truncation
			while (stack.length && results.length <= limit) {
				const frame = stack.at(-1)!;

				// Lazily fetch children by parentId via index; avoid .collect()
				const iterator =
					frame.iterator ??
					ctx.db
						.query("pages")
						.withIndex("by_workspace_project_parent_id_and_is_archived", (q) =>
							q
								.eq("workspace_id", args.workspaceId)
								.eq("project_id", args.projectId)
								.eq("parent_id", frame.parentId)
								.eq("is_archived", false),
						)
						[Symbol.asyncIterator]();

				const iteratorItem = await iterator.next();

				// No more children at this frame or page is empty or `maxDepth` is reached
				if (iteratorItem.done) {
					stack.pop();
					// Clean up the iterator
					await iterator.return?.();

					continue;
				}

				const child = iteratorItem.value;
				const childPath =
					frame.absPath === "/"
						? `/${encode_path_segment(child.name)}`
						: `${frame.absPath}/${encode_path_segment(child.name)}`;

				// If include pattern is provided, only add items that match the glob
				if (matchesInclude(childPath)) {
					if (results.length < limit && frame.depth <= maxDepth) {
						results.push({ path: childPath, updatedAt: child.updated_at, depthTruncated: false });
					}
					// Respect the `maxDepth` and mark the depth truncation
					else if (frame.depth > maxDepth) {
						stack.pop();
						// Clean up the iterator
						await iterator.return?.();

						const lastResult = results.at(-1);
						if (lastResult) {
							lastResult.depthTruncated = true;
						}

						continue;
					}
					// Respect `limit` and mark the truncation
					else {
						truncated = true;
						break;
					}
				}

				// Then, push the child to dive deeper first (pre-order/JSON.stringify-like walk)
				const nextDepth = frame.depth + 1;
				// less or equal `maxDepth` to allow the extra depth iteration
				if (nextDepth <= maxDepth + 1) {
					// Set frame on parent frame to resume iteration
					frame.iterator = iterator;
					stack.push({
						parentId: child.page_id,
						absPath: childPath,
						depth: nextDepth,
						iterator: null,
					});
				}
			}
		} finally {
			// Clean up the iterators
			await Promise.all(stack.map((frame) => frame.iterator?.return?.()).filter((x) => x != null));
		}

		return { items: results, truncated };
	},
});

export const page_exists_by_path = internalQuery({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const pageId = await resolve_page_id_from_path_fn(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
		if (!pageId) return false;

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", pageId),
			)
			.first();

		if (!page) return false;
		if (page.workspace_id !== args.workspaceId || page.project_id !== args.projectId) return false;
		return true;
	},
});

export const get_page_last_available_markdown_content_by_path = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		userId: v.string(),
		threadId: v.string(),
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const pageId = await resolve_id_from_path(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			path: args.path,
		});

		if (!pageId) return null;

		const page = await ctx.db.get("pages", pageId);

		if (!page) return null;
		if (page.is_archived) return null;

		const overlay = await ctx.db
			.query("ai_chat_pending_edits")
			.withIndex("by_user_thread_page", (q) =>
				q
					.eq("user_id", args.userId as string)
					.eq("thread_id", args.threadId as string)
					.eq("page_id", page.page_id),
			)
			.first();
		if (overlay) return overlay.modified_content;

		if (!page.markdown_content_id) {
			throw should_never_happen("page.markdown_content_id is not set", {
				pageId,
				markdownContentId: page.markdown_content_id,
			});
		}

		const markdownContentDoc = await ctx.db.get("pages_markdown_content", page.markdown_content_id);
		if (!markdownContentDoc) return null;

		return markdownContentDoc.content;
	},
});

export const get_page_text_content_by_page_id = query({
	args: { workspaceId: v.string(), projectId: v.string(), pageId: v.id("pages") },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		return "";
	},
});

/**
 * Returns the "best available" page content without doing any heavy reconstruction work.
 *
 * We keep multiple representations of a page:
 * - `pages_markdown_content` (fast to serve to editors/search)
 * - Yjs state (`pages_yjs_snapshots` + `pages_yjs_updates`) as the source-of-truth for collaborative editing
 *
 * The key is the monotonic Yjs `sequence`:
 * - `pages_yjs_docs_last_sequences.last_sequence` is the authoritative "latest" sequence for the page
 * - `pages_markdown_content.yjs_sequence` tells us which Yjs sequence the markdown was derived from
 * - `pages_yjs_snapshots.sequence` tells us which Yjs sequence a snapshot represents
 *
 * Resolution order (stop at the first consistent option):
 * - If markdown's `yjs_sequence` matches `last_sequence`, we can safely return markdown (cheap and already rendered).
 * - Otherwise, if the stored Yjs snapshot's `sequence` matches `last_sequence`, return the snapshot (caller can decode).
 * - Otherwise, return the snapshot plus all incremental Yjs updates so the caller can reconstruct the latest state.
 *
 * Any missing/unauthorized docs cause an early `null` return.
 */
export const try_get_markdown_content_or_fallback_to_yjs_data = query({
	args: { workspaceId: v.string(), projectId: v.string(), pageId: v.id("pages") },
	handler: async (ctx, args) => {
		let result;
		do {
			const page = await ctx.db.get("pages", args.pageId).then((page) => {
				if (!page || page.workspace_id !== args.workspaceId || page.project_id !== args.projectId) return null;
				return page;
			});

			if (!page || !page.markdown_content_id || !page.yjs_last_sequence_id) {
				throw should_never_happen("page.markdown_content_id or page.yjs_last_sequence_id is not set", {
					pageId: args.pageId,
					markdownContentId: page?.markdown_content_id,
					yjsLastSequenceId: page?.yjs_last_sequence_id,
				});
			}

			const [lastYjsSequenceDoc, markdownContentDoc] = await Promise.all([
				ctx.db.get("pages_yjs_docs_last_sequences", page.yjs_last_sequence_id).then((doc) => {
					if (!doc || doc.workspace_id !== args.workspaceId || doc.project_id !== args.projectId) return null;
					return doc;
				}),
				ctx.db.get("pages_markdown_content", page.markdown_content_id).then((doc) => {
					if (!doc || doc.workspace_id !== args.workspaceId || doc.project_id !== args.projectId) return null;
					return doc;
				}),
			]);

			if (!lastYjsSequenceDoc || !markdownContentDoc) {
				throw should_never_happen("lastYjsSequenceDoc or markdownContentDoc is not valorized", {
					pageId: args.pageId,
					lastYjsSequenceDoc: lastYjsSequenceDoc,
					markdownContentDoc: markdownContentDoc,
				});
			}

			if (markdownContentDoc.yjs_sequence === lastYjsSequenceDoc.last_sequence) {
				result = {
					kind: "markdown_content" as const,
					markdownContentDoc,
				};
				break;
			}

			if (!page.yjs_snapshot_id) {
				throw should_never_happen("page.yjs_snapshot_id is not set", {
					pageId: args.pageId,
					yjsSnapshotId: page.yjs_snapshot_id,
				});
			}

			const yjsSnapshotDoc = await ctx.db.get("pages_yjs_snapshots", page.yjs_snapshot_id).then((doc) => {
				if (!doc || doc.workspace_id !== args.workspaceId || doc.project_id !== args.projectId) return null;
				return doc;
			});

			if (!yjsSnapshotDoc) {
				throw should_never_happen("yjsSnapshotDoc is not valorized", {
					pageId: args.pageId,
					yjsSnapshotDoc: yjsSnapshotDoc,
				});
			}

			if (yjsSnapshotDoc.sequence === lastYjsSequenceDoc.last_sequence) {
				result = {
					kind: "yjs_snapshot" as const,
					yjsSnapshotDoc,
				};
				break;
			}

			const yjsUpdatesDocs = await ctx.db
				.query("pages_yjs_updates")
				.withIndex("by_workspace_project_and_page_id_and_sequence", (q) =>
					q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
				)
				.order("asc")
				.collect();

			if (yjsUpdatesDocs.length === 0) {
				throw should_never_happen(
					"yjsUpdatesDocs are empty even though the last sequence does not match the snapshot sequence",
					{
						pageId: args.pageId,
						yjsUpdatesDocs: yjsUpdatesDocs,
					},
				);
			}

			result = {
				kind: "yjs_snapshots_with_incremental_updates" as const,
				yjsSnapshotDoc,
				yjsUpdatesDocs,
			};
		} while (0);

		return result;
	},
});

export const get_page_last_yjs_sequence = query({
	args: { workspaceId: v.string(), projectId: v.string(), pageId: v.id("pages") },
	returns: v.union(v.object({ last_sequence: v.number() }), v.null()),
	handler: async (ctx, args) => {
		const page = await ctx.db.get("pages", args.pageId).then((page) => {
			if (!page || page.workspace_id !== args.workspaceId || page.project_id !== args.projectId) return null;
			return page;
		});

		if (!page) {
			return null;
		}

		if (!page.yjs_last_sequence_id) {
			throw should_never_happen("page.yjs_last_sequence_id is not set", {
				pageId: args.pageId,
				yjsLastSequenceId: page.yjs_last_sequence_id,
			});
		}

		const lastYjsSequenceDoc = await ctx.db
			.get("pages_yjs_docs_last_sequences", page.yjs_last_sequence_id)
			.then((doc) => {
				if (!doc || doc.workspace_id !== args.workspaceId || doc.project_id !== args.projectId) return null;
				return doc;
			});

		if (!lastYjsSequenceDoc) {
			throw should_never_happen("lastYjsSequenceDoc is not valorized", {
				pageId: args.pageId,
				yjsLastSequenceId: page.yjs_last_sequence_id,
			});
		}

		return { last_sequence: lastYjsSequenceDoc.last_sequence };
	},
});

export const text_search_pages = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		query: v.string(),
		limit: v.number(),
		userId: v.string(),
		threadId: v.string(),
	},
	returns: v.object({
		items: v.array(
			v.object({
				path: v.string(),
				preview: v.string(),
			}),
		),
	}),
	handler: async (ctx, args): Promise<{ items: Array<{ path: string; preview: string }> }> => {
		const matches = await ctx.db
			.query("pages_markdown_content")
			.withSearchIndex("search_by_content", (q) =>
				q
					.search("content", args.query)
					.eq("workspace_id", args.workspaceId)
					.eq("project_id", args.projectId)
					.eq("is_archived", false),
			)
			.take(Math.max(1, Math.min(100, args.limit)));

		const items: Array<{ path: string; preview: string }> = await Promise.all(
			matches.map(async (page): Promise<{ path: string; preview: string }> => {
				const path: string = await resolve_path_from_page_id(ctx, {
					workspace_id: args.workspaceId,
					project_id: args.projectId,
					page_id: page.page_id,
				});
				const pending = await ctx.db
					.query("ai_chat_pending_edits")
					.withIndex("by_user_thread_page", (q) =>
						q.eq("user_id", args.userId).eq("thread_id", args.threadId).eq("page_id", page.page_id),
					)
					.first();
				const preview = (pending?.modified_content ?? page.content).slice(0, 160);
				return { path, preview };
			}),
		);

		return { items };
	},
});

export const create_page_by_path = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		userId: v.string(),
		threadId: v.string(),
	},
	returns: v.object({ page_id: v.id("pages") }),
	handler: async (ctx, args) => {
		const { workspaceId, projectId } = args;
		const segments = server_path_extract_segments_from(args.path);

		let currentParent = pages_ROOT_ID;
		let lastPageId = null;

		for (let i = 0; i < segments.length; i++) {
			const name = segments[i];

			// Does this segment exist?
			const existing = await ctx.db
				.query("pages")
				.withIndex("by_workspace_project_parent_id_and_name", (q) =>
					q.eq("workspace_id", workspaceId).eq("project_id", projectId).eq("parent_id", currentParent).eq("name", name),
				)
				.unique();

			if (!existing) {
				// Create missing segment
				const clientGeneratedPageId = generate_id("page");
				const pageId = await do_create_page(ctx, {
					workspace_id: workspaceId,
					project_id: projectId,
					page_id: clientGeneratedPageId,
					parent_id: currentParent,
					name: name,
					markdown_content: "",
				});
				currentParent = pageId;
				lastPageId = pageId;
			} else {
				// Continue traversal
				currentParent = existing._id;
				lastPageId = existing._id;

				// If it's the leaf and exists already, we should not create; caller decides overwrite path.
				if (i === segments.length - 1) {
					return { page_id: lastPageId };
				}
			}
		}

		if (!lastPageId) {
			throw should_never_happen("lastPageId not resolved after page creation");
		}

		return { page_id: lastPageId };
	},
});

export const ensure_home_page = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: v.object({ page_id: v.string() }),
	handler: async (ctx, args): Promise<{ page_id: string }> => {
		// Find homepage (empty name under root)
		const homepage = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_parent_id_and_name", (q) =>
				q
					.eq("workspace_id", args.workspaceId)
					.eq("project_id", args.projectId)
					.eq("parent_id", pages_ROOT_ID)
					.eq("name", ""),
			)
			.first();

		if (homepage) {
			return { page_id: homepage.page_id };
		}

		// Create homepage with empty name
		const pageId = `page-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await do_create_page(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: pageId,
			parent_id: pages_ROOT_ID,
			name: "",
			markdown_content: "",
		});

		return { page_id: pageId };
	},
});

// Shared helper for snapshot creation
const store_version_snapshot_args_schema = v.object({
	workspace_id: v.string(),
	project_id: v.string(),
	page_id: v.id("pages"),
	content: v.string(),
	created_by: v.id("users"),
});

export const get_page_snapshots_list = query({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.id("pages"),
		show_archived: v.boolean(),
	},
	returns: v.object({
		snapshots: v.array(doc(app_convex_schema, "pages_snapshots")),
		usersDict: v.record(
			v.id("users"),
			v.object({
				_id: v.id("users"),
				displayName: v.string(),
			}),
		),
	}),
	handler: async (ctx, args) => {
		let snapshotsQuery = ctx.db
			.query("pages_snapshots")
			.withIndex("by_page_id", (q) => q.eq("page_id", args.page_id))
			.order("desc");

		// Filter only not archived snapshots if show_archived is falsy
		if (!args.show_archived) {
			snapshotsQuery = snapshotsQuery.filter((q) => q.eq(q.field("is_archived"), false));
		}

		const snapshots = await snapshotsQuery.collect();

		const usersDict: Record<Id<"users">, { _id: Id<"users">; displayName: string }> = {};

		const uniqueUserIds = Array.from(new Set(snapshots.map((s) => s.created_by)));
		const usersWithAnagraphics = await Promise.all(
			uniqueUserIds.map((userId) => ctx.runQuery(internal.users.get_with_anagraphic, { userId })),
		);

		for (const userWithAnagraphic of usersWithAnagraphics) {
			if (!userWithAnagraphic || !userWithAnagraphic.anagraphic) continue;

			usersDict[userWithAnagraphic.user._id] = {
				_id: userWithAnagraphic.user._id,
				displayName: userWithAnagraphic.anagraphic.displayName,
			};
		}

		return {
			snapshots,
			usersDict,
		};
	},
});

async function do_get_page_snapshot_content(
	ctx: QueryCtx,
	args: { workspace_id: string; project_id: string; page_snapshot_id: Id<"pages_snapshots"> },
) {
	const content = await ctx.db
		.query("pages_snapshots_contents")
		.withIndex("by_workspace_project_and_page_snapshot_id", (q) =>
			q
				.eq("workspace_id", args.workspace_id)
				.eq("project_id", args.project_id)
				.eq("page_snapshot_id", args.page_snapshot_id),
		)
		.first();

	if (!content) {
		return null;
	}

	const snapshot = await ctx.db.get("pages_snapshots", args.page_snapshot_id);
	if (!snapshot) {
		return null;
	}

	const usersDict: Record<Id<"users">, { _id: Id<"users">; displayName: string }> = {};
	const user = await ctx.db.get("users", snapshot.created_by);
	const anagraphic = user?.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
	if (user && anagraphic) {
		usersDict[user._id] = { _id: user._id, displayName: anagraphic.displayName };
	}

	return {
		content: content.content,
		page_snapshot_id: content.page_snapshot_id,
		_creationTime: content._creationTime,
		created_by: snapshot.created_by,
		usersDict,
	};
}

export const get_page_snapshot_content = query({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.id("pages"),
		page_snapshot_id: v.id("pages_snapshots"),
	},
	returns: v.union(
		v.object({
			content: v.string(),
			page_snapshot_id: v.id("pages_snapshots"),
			_creationTime: v.number(),
			created_by: v.id("users"),
			usersDict: v.record(
				v.id("users"),
				v.object({
					_id: v.id("users"),
					displayName: v.string(),
				}),
			),
		}),
		v.null(),
	),
	handler: do_get_page_snapshot_content,
});

export const archive_snapshot = mutation({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_snapshot_id: v.id("pages_snapshots"),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch("pages_snapshots", args.page_snapshot_id, {
			is_archived: true,
		});
	},
});

export const unarchive_snapshot = mutation({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_snapshot_id: v.id("pages_snapshots"),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch("pages_snapshots", args.page_snapshot_id, {
			is_archived: false,
		});
	},
});

function yjs_merge_updates_to_array_buffer(updates: Uint8Array[]) {
	return pages_u8_to_array_buffer(mergeUpdates(updates));
}

function yjs_create_state_update_from_tiptap_editor(args: { tiptapEditor: Editor }) {
	const yjsDoc = pages_yjs_doc_create_from_tiptap_editor({
		tiptapEditor: args.tiptapEditor,
	});
	return encodeStateAsUpdate(yjsDoc);
}

function yjs_compute_diff_update_with_headless_tiptap_editor(args: {
	pageYjsData: Doc<"pages_yjs_snapshots">;
	headlessEditorWithUpdatedContent: Editor;
	opKind: "snapshot-restore" | "user-edit";
}) {
	const yjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.pageYjsData.snapshot_update);
	const yjsBeforeStateVector = encodeStateVector(yjsDoc);

	pages_yjs_doc_update_from_tiptap_editor({
		mut_yjsDoc: yjsDoc,
		tiptapEditor: args.headlessEditorWithUpdatedContent,
		opKind: args.opKind,
	});

	// TODO: there's a small performance improvement that can be achieved by listening for updates events from ydoc
	const diffUpdate = pages_yjs_compute_diff_update_from_state_vector({ yjsDoc, yjsBeforeStateVector });

	return diffUpdate;
}

async function write_markdown_to_yjs_sync(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		pageId: Id<"pages">;
		markdownContent: string;
		sessionId: string;
		pageSnapshotId: Id<"pages_snapshots">;
	},
) {
	// Reconstruct the latest Y.Doc from last snapshot
	const pageYjsData = await ctx.db
		.query("pages_yjs_snapshots")
		.withIndex("by_workspace_project_and_page_id_and_sequence", (q) =>
			q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
		)
		.order("desc")
		.first();

	if (!pageYjsData) {
		return;
	}

	// Convert markdown to TipTap JSON
	const headlessEditor = pages_headless_tiptap_editor_create({
		initialContent: { markdown: args.markdownContent },
	});

	const diffUpdate = yjs_compute_diff_update_with_headless_tiptap_editor({
		pageYjsData,
		headlessEditorWithUpdatedContent: headlessEditor,
		opKind: "snapshot-restore",
	});

	if (!diffUpdate) {
		return;
	}

	const newSnapshotUpdate = yjs_merge_updates_to_array_buffer([
		new Uint8Array(pageYjsData.snapshot_update),
		diffUpdate,
	]);

	const newSequenceData = await yjs_increment_or_create_last_sequence(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		pageId: args.pageId,
	});

	await Promise.all([
		ctx.db.insert("pages_yjs_updates", {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
			sequence: newSequenceData.last_sequence,
			update: pages_u8_to_array_buffer(diffUpdate),
			origin: {
				type: "USER_SNAPSHOT_RESTORE",
				snapshot_id: args.pageSnapshotId,
			},
			created_by: args.userId,
			created_at: Date.now(),
		}),

		ctx.db.patch("pages_yjs_snapshots", pageYjsData._id, {
			sequence: newSequenceData.last_sequence,
			snapshot_update: newSnapshotUpdate,
			updated_at: Date.now(),
			updated_by: args.userId,
		}),
	]);
}

export const yjs_get_doc_last_snapshot = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
	},
	returns: v.union(doc(app_convex_schema, "pages_yjs_snapshots"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("pages_yjs_snapshots")
			.withIndex("by_workspace_project_and_page_id_and_sequence", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.order("desc")
			.first();
	},
});

export const yjs_snapshot_updates = internalMutation({
	args: {
		userId: v.id("users"),
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();

		const scheduleLocksPromise = ctx.db
			.query("pages_yjs_snapshot_schedules")
			.withIndex("by_page_id", (q) => q.eq("page_id", args.pageId))
			.collect();

		try {
			const page = await ctx.db.get("pages", args.pageId);
			if (
				!page ||
				page.workspace_id !== args.workspaceId ||
				page.project_id !== args.projectId ||
				!page.markdown_content_id
			) {
				throw should_never_happen("page not found", {
					pageId: args.pageId,
					page: page,
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					markdownContentId: page?.markdown_content_id,
				});
			}

			// Load latest snapshot
			const yjsSnapshotData = await ctx.db
				.query("pages_yjs_snapshots")
				.withIndex("by_workspace_project_and_page_id_and_sequence", (q) =>
					q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
				)
				.order("desc")
				.first();

			if (!yjsSnapshotData) {
				throw should_never_happen(
					"yjs_snapshot_data or last_sequence_data are null.\n" + //
						"The job should start only if the last sequence exists and is greater than 0\n" + //
						"and only if the yjs snapshot data already exists, the snapshot data should\n" + //
						"be created with the page",
				);
			}

			// Fetch updates since snapshot up to uptoSeq
			const updateDataList = await ctx.db
				.query("pages_yjs_updates")
				.withIndex("by_workspace_project_and_page_id_and_sequence", (q) =>
					q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
				)
				.order("asc")
				.collect();

			const lastUpdate = updateDataList.at(-1);
			const sequence = lastUpdate ? lastUpdate.sequence : yjsSnapshotData.sequence;

			// merge last snapshot update with all incremental updates into a single update blob
			const snapshotUpdate = yjs_merge_updates_to_array_buffer([
				new Uint8Array(yjsSnapshotData.snapshot_update),
				...updateDataList.map((u) => new Uint8Array(u.update)),
			]);

			const yjsDoc = pages_yjs_doc_create_from_array_buffer_update(snapshotUpdate);
			const markdown = pages_yjs_doc_get_markdown({ yjsDoc });

			await Promise.all([
				// Write new snapshot row (append-only)
				ctx.db.patch("pages_yjs_snapshots", yjsSnapshotData._id, {
					sequence,
					snapshot_update: snapshotUpdate,
					updated_by: "system",
					updated_at: now,
				}),

				// Prune compacted updates
				...updateDataList.map((updateData) => ctx.db.delete("pages_yjs_updates", updateData._id)),

				ctx.db.patch("pages_markdown_content", page.markdown_content_id, {
					content: markdown,
					yjs_sequence: sequence,
					updated_by: "system",
					updated_at: now,
				}),

				store_version_snapshot(ctx, {
					workspace_id: args.workspaceId,
					project_id: args.projectId,
					page_id: args.pageId,
					content: markdown,
					created_by: args.userId,
				}),
			]);

			return null;
		} finally {
			await scheduleLocksPromise.then((scheduleLocks) =>
				Promise.all(scheduleLocks.map((schedule) => ctx.db.delete("pages_yjs_snapshot_schedules", schedule._id))),
			);
		}
	},
});

async function yjs_increment_or_create_last_sequence(
	ctx: MutationCtx,
	args: { workspaceId: string; projectId: string; pageId: Id<"pages"> },
) {
	let lastSequenceData = await ctx.db
		.query("pages_yjs_docs_last_sequences")
		.withIndex("by_workspace_project_and_page_id", (q) =>
			q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
		)
		.order("desc")
		.first();

	const newSequence = lastSequenceData ? lastSequenceData.last_sequence + 1 : 0;

	// Update or create last_sequence tracking
	if (lastSequenceData) {
		await ctx.db.patch("pages_yjs_docs_last_sequences", lastSequenceData._id, { last_sequence: newSequence });
		lastSequenceData.last_sequence = newSequence;
	} else {
		const lastSequenceDataId = await ctx.db.insert("pages_yjs_docs_last_sequences", {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
			last_sequence: 0,
		});
		lastSequenceData = (await ctx.db.get("pages_yjs_docs_last_sequences", lastSequenceDataId))!;
	}

	return lastSequenceData;
}

export const yjs_push_update = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		update: v.bytes(),
		sessionId: v.string(),
	},
	returns: v.union(
		v.null(),
		v.object({
			newSequence: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const now = Date.now();

		const newSequenceData = await yjs_increment_or_create_last_sequence(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			pageId: args.pageId,
		});

		await ctx.db.insert("pages_yjs_updates", {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
			sequence: newSequenceData.last_sequence,
			update: args.update,
			origin: {
				type: "USER_EDIT",
				session_id: args.sessionId,
			},
			created_by: user.name,
			created_at: now,
		});

		const snapshotScheduleDelayMs =
			newSequenceData.last_sequence > 0 && newSequenceData.last_sequence % 50 === 0 ? 0 : 30_000;

		const schedules = await ctx.db
			.query("pages_yjs_snapshot_schedules")
			.withIndex("by_page_id", (q) => q.eq("page_id", args.pageId))
			.collect();

		const scheduledId = await ctx.scheduler.runAfter(
			snapshotScheduleDelayMs,
			internal.ai_docs_temp.yjs_snapshot_updates,
			{
				userId: user.id,
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				pageId: args.pageId,
			},
		);

		await Promise.all([
			schedules[0]
				? ctx.db.patch("pages_yjs_snapshot_schedules", schedules[0]._id, { scheduled_function_id: scheduledId })
				: ctx.db.insert("pages_yjs_snapshot_schedules", { page_id: args.pageId, scheduled_function_id: scheduledId }),
			...schedules.slice(1).map((schedule) => ctx.db.delete("pages_yjs_snapshot_schedules", schedule._id)),
		]);

		return { newSequence: newSequenceData.last_sequence };
	},
});

export const yjs_get_incremental_updates = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
	},
	returns: v.union(
		v.object({
			updates: v.array(doc(app_convex_schema, "pages_yjs_updates")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const updates = await ctx.db
			.query("pages_yjs_updates")
			.withIndex("by_workspace_project_and_page_id_and_sequence", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.order("desc")
			.collect();

		if (updates.length === 0) {
			return null;
		}

		return { updates };
	},
});

async function store_version_snapshot(ctx: MutationCtx, args: Infer<typeof store_version_snapshot_args_schema>) {
	// Create snapshot entry
	const snapshotId = await ctx.db.insert("pages_snapshots", {
		workspace_id: args.workspace_id,
		project_id: args.project_id,
		page_id: args.page_id,
		created_by: args.created_by,
		is_archived: false,
	});

	// Create content entry
	await ctx.db.insert("pages_snapshots_contents", {
		workspace_id: args.workspace_id,
		project_id: args.project_id,
		page_snapshot_id: snapshotId,
		content: args.content,
		page_id: args.page_id,
	});

	return snapshotId;
}

export const restore_snapshot = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		pageSnapshotId: v.id("pages_snapshots"),
		sessionId: v.string(),
		currentMarkdownContent: v.string(),
	},
	returns: v.union(
		v.object({
			_yay: v.null(),
		}),
		v.object({
			_nay: v.object({
				name: v.string(),
				message: v.string(),
			}),
		}),
	),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const [snapshotContent, page] = await Promise.all([
			do_get_page_snapshot_content(ctx, {
				workspace_id: args.workspaceId,
				project_id: args.projectId,
				page_snapshot_id: args.pageSnapshotId,
			}),
			ctx.db.get("pages", args.pageId).then((doc) => {
				if (!doc || doc.workspace_id !== args.workspaceId || doc.project_id !== args.projectId) return null;
				return doc;
			}),
		]);

		if (
			!snapshotContent ||
			!page ||
			!page.markdown_content_id ||
			page.workspace_id !== args.workspaceId ||
			page.project_id !== args.projectId
		) {
			const msg = "Page not found";
			console.error(
				should_never_happen(msg, {
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					pageId: args.pageId,
					snapshotContentNotFound: !snapshotContent,
					pageNotFound: !page,
					markdownContentIdNotFound: !page?.markdown_content_id,
				}),
			);
			return Result({
				_nay: {
					name: "nay",
					message: msg,
				},
			});
		}

		const createdBy = user.id;
		const updatedBy = user.name;
		const updatedAt = Date.now();

		// Restoring snapshots can be destructive and we defensively store
		// the current state as a backup snapshot
		// so the user can revert to it if needed.
		await Promise.all([
			// Store current state as a backup snapshot
			store_version_snapshot(ctx, {
				workspace_id: args.workspaceId,
				project_id: args.projectId,
				page_id: args.pageId,
				content: args.currentMarkdownContent,
				created_by: createdBy,
			}),

			// Store the restored content as a new snapshot
			store_version_snapshot(ctx, {
				workspace_id: args.workspaceId,
				project_id: args.projectId,
				page_id: args.pageId,
				content: snapshotContent.content,
				created_by: createdBy,
			}),

			ctx.db.patch("pages", page._id, {
				updated_by: updatedBy,
				updated_at: updatedAt,
			}),

			ctx.db.patch("pages_markdown_content", page.markdown_content_id, {
				content: snapshotContent.content,
				updated_by: updatedBy,
				updated_at: updatedAt,
			}),

			write_markdown_to_yjs_sync(ctx, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				userId: user.name,
				pageId: args.pageId,
				markdownContent: snapshotContent.content,
				sessionId: args.sessionId,
				pageSnapshotId: args.pageSnapshotId,
			}),
		]);

		return Result({
			_yay: null,
		});
	},
});

/**
 * Internal mutation to cleanup old snapshots based on retention rules.
 * Runs daily at 5AM UTC via cron job.
 *
 * Retention rules:
 * - Older than 30 days: keep only the last snapshot for each week
 * - Older than 7 days (but <= 30 days): keep only the last snapshot for each day
 * - Older than 1 day (but <= 7 days): keep only the last snapshot each hour
 * - <= 1 day old: keep all snapshots
 */
export const cleanup_old_snapshots = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const timestamp60DaysAgo = now - 60 * 24 * 60 * 60 * 1000;

		const latestSnapshotPageIdWithTimeSlot = new Set<string>();
		const deletePromises: Array<Promise<any>> = [];

		const snapshotsToScanCursor = ctx.db
			.query("pages_snapshots")
			.withIndex("by_creation_time", (q) => q.gte("_creationTime", timestamp60DaysAgo))
			.order("desc");

		for await (const snapshot of snapshotsToScanCursor) {
			const age = now - snapshot._creationTime;
			let keepSnapshot = false;

			// If the snapshot is less than 1 day old, keep it
			if (age <= date_MS_DAY) {
				keepSnapshot = true;
			} else {
				// If the snapshot is older than 1 day, we need to determine the time slot it belongs to
				let bucketTimestamp: number;

				if (age > date_MS_DAYS_30) {
					bucketTimestamp = date_get_week_start_timestamp(snapshot._creationTime);
				} else if (age > date_MS_WEEK) {
					bucketTimestamp = date_get_day_start_timestamp(snapshot._creationTime);
				} else {
					bucketTimestamp = date_get_hour_start_timestamp(snapshot._creationTime);
				}

				// If this is the first snapshot for this time slot, it means it's the latest
				// therefore we keep it
				const snapshotTimeSlotKey = `${snapshot.page_id}::${bucketTimestamp}`;
				if (!latestSnapshotPageIdWithTimeSlot.has(snapshotTimeSlotKey)) {
					latestSnapshotPageIdWithTimeSlot.add(snapshotTimeSlotKey);
					keepSnapshot = true;
				}
			}

			if (!keepSnapshot) {
				deletePromises.push(
					// TODO: If we save the content id in the snapshot doc we can use the more efficient .get
					ctx.db
						.query("pages_snapshots_contents")
						.withIndex("by_workspace_project_and_page_snapshot_id", (q) =>
							q
								.eq("workspace_id", snapshot.workspace_id)
								.eq("project_id", snapshot.project_id)
								.eq("page_snapshot_id", snapshot._id),
						)
						.first()
						.then((content) => content && ctx.db.delete("pages_snapshots_contents", content._id)),
					ctx.db.delete("pages_snapshots", snapshot._id),
				);
			}
		}

		await Promise.all(deletePromises);

		return null;
	},
});

export function pages_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/api/ai-docs-temp/contextual-prompt" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						const bodyValidator = z.object({
							prompt: z.string(),
							option: z.string().optional(),
							command: z.string().optional(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							try {
								const bodyResult = await server_request_json_parse_and_validate(request, bodyValidator);
								if (bodyResult._nay) {
									return {
										status: 400,
										body: bodyResult._nay,
									} as const;
								}

								const { prompt, option, command } = bodyResult._yay;

								if (!prompt || typeof prompt !== "string") {
									return {
										status: 400,
										body: {
											message: "Invalid prompt",
										},
									} as const;
								}

								// Create appropriate system and user prompts based on option (matching liveblocks pattern)
								let systemPrompt = "";
								let userPrompt = "";

								switch (option) {
									case "continue":
										systemPrompt =
											"You are an AI writing assistant that continues existing text based on context from prior text. " +
											"Give more weight/priority to the later characters than the beginning ones. " +
											"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = prompt;
										break;
									case "improve":
										systemPrompt =
											"You are an AI writing assistant that improves existing text. " +
											"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = `The existing text is: ${prompt}`;
										break;
									case "shorter":
										systemPrompt =
											"You are an AI writing assistant that shortens existing text. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = `The existing text is: ${prompt}`;
										break;
									case "longer":
										systemPrompt =
											"You are an AI writing assistant that lengthens existing text. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = `The existing text is: ${prompt}`;
										break;
									case "fix":
										systemPrompt =
											"You are an AI writing assistant that fixes grammar and spelling errors in existing text. " +
											"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = `The existing text is: ${prompt}`;
										break;
									case "zap":
										systemPrompt =
											"You area an AI writing assistant that generates text based on a prompt. " +
											"You take an input from the user and a command for manipulating the text. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = `For this text: ${prompt}. You have to respect the command: ${command}`;
										break;
									default:
										systemPrompt =
											"You are an AI writing assistant. Help with the given text based on the user's needs.";
										userPrompt = command ? `${command}\n\nText: ${prompt}` : `Continue this text:\n\n${prompt}`;
								}

								// Generate streaming completion using AI SDK v5 UI message stream response
								const result = streamText({
									model: openai("gpt-5-mini"),
									system: systemPrompt,
									messages: [
										{
											role: "user",
											content: userPrompt,
										},
									],
									temperature: 0.7,
									maxOutputTokens: 500,
									experimental_transform: smoothStream({
										delayInMs: 100,
									}),
								});

								return {
									status: 200,
									body: result,
								} as const;
							} catch (error: unknown) {
								console.error("AI generation error:", error);
								return {
									status: 500,
									body: {
										message: error instanceof Error ? error.message : "Internal server error",
									},
								} as const;
							}
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);

								if (result.status === 200) {
									return result.body.toUIMessageStreamResponse({
										onError: (error) => {
											console.error("AI generation error:", error);
											return error instanceof Error ? error.message : String(error);
										},
									});
								}

								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
