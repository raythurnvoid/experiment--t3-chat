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
	action,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { internal, api } from "./_generated/api.js";
import { paginationOptsValidator } from "convex/server";
import { streamText, smoothStream } from "ai";
import { openai } from "@ai-sdk/openai";
import {
	server_path_extract_segments_from,
	server_convex_get_user_fallback_to_anonymous,
	server_convex_headers_cors,
	server_request_json_parse_and_validate,
	server_convex_response_error_client,
	server_convex_response_error_server,
	encode_path_segment,
} from "../server/server-utils.ts";
import { parsePatch, applyPatches } from "@sanity/diff-match-patch";
import { v, type Infer } from "convex/values";
import { api_schemas_Main_api_ai_docs_temp_contextual_prompt_body_schema } from "../shared/api-schemas.ts";
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
	pages_YJS_DOC_KEYS,
	ai_docs_create_liveblocks_room_id,
} from "../server/pages.ts";
import { minimatch } from "minimatch";
import { z } from "zod";
import { Result } from "../src/lib/errors-as-values-utils.ts";
import { server_page_editor_markdown_to_json, server_page_editor_get_schema } from "../server/page-editor.ts";
import { Doc as YDoc, encodeStateVector, encodeStateAsUpdate, applyUpdate } from "yjs";
import { initProseMirrorDoc, updateYFragment } from "@tiptap/y-tiptap";
import { simpleDiff } from "lib0/diff";

export const contextual_prompt = httpAction(async (ctx, request) => {
	try {
		const bodyResult = await server_request_json_parse_and_validate(
			request,
			api_schemas_Main_api_ai_docs_temp_contextual_prompt_body_schema,
		);
		if (bodyResult._nay) {
			return server_convex_response_error_client({
				body: bodyResult._nay,
				headers: server_convex_headers_cors(),
			});
		}

		const { prompt, option, command } = bodyResult._yay;

		if (!prompt || typeof prompt !== "string") {
			return server_convex_response_error_client({
				body: {
					message: "Invalid prompt",
				},
				headers: server_convex_headers_cors(),
			});
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
					"You are an AI writing assistant that shortens existing text. " + "Use Markdown formatting when appropriate.";
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
				systemPrompt = "You are an AI writing assistant. Help with the given text based on the user's needs.";
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

		return result.toUIMessageStreamResponse({
			onError: (error) => {
				console.error("AI generation error:", error);
				return error instanceof Error ? error.message : String(error);
			},
			headers: server_convex_headers_cors(),
		});
	} catch (error: unknown) {
		console.error("AI generation error:", error);
		return server_convex_response_error_server({
			body: {
				message: error instanceof Error ? error.message : "Internal server error",
			},
			headers: server_convex_headers_cors(),
		});
	}
});

async function resolve_id_from_path(ctx: QueryCtx, args: { workspace_id: string; project_id: string; path: string }) {
	if (args.path === "/") return null;

	const segments = server_path_extract_segments_from(args.path);

	let docId = null;
	let currentNode = pages_ROOT_ID;

	for (const segment of segments) {
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_parent_id_and_name", (q) =>
				q
					.eq("workspace_id", args.workspace_id)
					.eq("project_id", args.project_id)
					.eq("parent_id", currentNode)
					.eq("name", segment),
			)
			.unique();

		if (!page) return null;
		currentNode = page.page_id;
		docId = page._id;
	}

	return docId;
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
			.withIndex("by_workspace_project_and_parent_id_and_name", (q) =>
				q
					.eq("workspace_id", args.workspaceId)
					.eq("project_id", args.projectId)
					.eq("parent_id", currentNode)
					.eq("name", segment),
			)
			.unique();
		if (!page) return null;
		currentNode = page.page_id;
		pageId = page.page_id;
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
			.withIndex("by_workspace_project_and_parent_id_and_name", (q) =>
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
		content: v.string(),
		isArchived: v.boolean(),
		updatedAt: v.number(),
		updatedBy: v.string(),
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
			.collect();

		const treeItemsList: pages_TreeItem[] = [
			{
				type: "root",
				index: pages_ROOT_ID,
				parentId: "",
				title: "Pages",
				content: "",
				isArchived: false,
				updatedAt: Date.now(),
				updatedBy: "system",
			},
			...pages
				.filter((page) => page.page_id && page.name !== "")
				.map((page) => ({
					type: "page" as const,
					index: page.page_id,
					parentId: page.parent_id,
					title: page.name || "Untitled",
					content: `<h1>${page.name || "Untitled"}</h1><p>Start writing your content here...</p>`,
					isArchived: page.is_archived || false,
					updatedAt: page.updated_at,
					updatedBy: page.updated_by,
				})),
		];

		return treeItemsList;
	},
});

// Shared helper for page insertion
type CreatePageInsertArgs = {
	workspace_id: string;
	project_id: string;
	page_id: string;
	parent_id: string;
	name: string;
	text_content: string;
};

async function create_page_in_db(ctx: MutationCtx, args: CreatePageInsertArgs): Promise<string> {
	const user = await server_convex_get_user_fallback_to_anonymous(ctx);
	const now = Date.now();

	await ctx.db.insert("pages", {
		workspace_id: args.workspace_id,
		project_id: args.project_id,
		page_id: args.page_id,
		parent_id: args.parent_id,
		text_content: args.text_content,
		version: pages_FIRST_VERSION,
		name: args.name,
		is_archived: false,
		created_by: user.name,
		updated_by: user.name,
		updated_at: now,
	});

	return args.page_id;
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
		await create_page_in_db(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
			parent_id: args.parentId,
			name: args.name,
			text_content: "",
		});
	},
});

export const create_page_quick = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: v.object({ page_id: v.string() }),
	handler: async (ctx, args) => {
		const { workspaceId, projectId } = args;

		// Ensure ".tmp" under root exists
		const tmp = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_parent_id_and_name", (q) =>
				q.eq("workspace_id", workspaceId).eq("project_id", projectId).eq("parent_id", pages_ROOT_ID).eq("name", ".tmp"),
			)
			.first();

		let tmp_page_id: string;

		if (!tmp) {
			tmp_page_id = `.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
			await create_page_in_db(ctx, {
				workspace_id: workspaceId,
				project_id: projectId,
				page_id: tmp_page_id,
				parent_id: pages_ROOT_ID,
				name: ".tmp",
				text_content:
					"Automatically generated temp folder\n\nThis page contains temporary pages generated by the system.",
			});
		} else {
			tmp_page_id = tmp.page_id;
		}

		// Create quick page under ".tmp"
		const page_id = `page-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const title = `Quick page created at ${new Date().toLocaleString("en-GB", { hour12: false })}`;

		await create_page_in_db(ctx, {
			workspace_id: workspaceId,
			project_id: projectId,
			page_id,
			parent_id: tmp_page_id,
			name: title,
			text_content: "",
		});

		return { page_id };
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
			await ctx.db.patch(page._id, {
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
				await ctx.db.patch(page._id, {
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
			await ctx.db.patch(page._id, {
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
			await ctx.db.patch(page._id, {
				is_archived: false,
				updated_by: user.name,
				updated_at: Date.now(),
			});
		}
	},
});

export const update_page_and_broadcast = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
		textContent: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		// Find page by composite key
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.first();

		if (page) {
			await ctx.db.patch(page._id, {
				text_content: args.textContent,
				updated_by: user.name,
				updated_at: Date.now(),
			});
		}
	},
});

export async function schedule_snapshot(
	ctx: MutationCtx,
	args: {
		page_id: string;
		workspace_id: string;
		project_id: string;
	},
) {
	// Query for existing scheduled snapshot for this page
	const existing = await ctx.db
		.query("pages_snapshot_schedules")
		.withIndex("by_page_id", (q) => q.eq("page_id", args.page_id))
		.first();

	// Cancel existing scheduled function if it exists
	if (existing) {
		await ctx.scheduler.cancel(existing.scheduled_function_id);
	}

	// Schedule new snapshot creation after 10 seconds
	const scheduledId = await ctx.scheduler.runAfter(10_000, internal.ai_docs_temp.create_snapshot_after_inactivity, {
		page_id: args.page_id,
		workspace_id: args.workspace_id,
		project_id: args.project_id,
	});

	// Store the scheduled function ID
	if (existing) {
		await ctx.db.replace(existing._id, {
			page_id: args.page_id,
			scheduled_function_id: scheduledId,
		});
	} else {
		await ctx.db.insert("pages_snapshot_schedules", {
			page_id: args.page_id,
			scheduled_function_id: scheduledId,
		});
	}

	return null;
}

/**
 * Internal mutation to update page content in the database.
 * Used by actions that need to update the DB from Node.js runtime.
 */
export const internal_update_page_content = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
		textContent: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.first();

		if (page) {
			await ctx.db.patch(page._id, {
				text_content: args.textContent,
				updated_by: user.name,
				updated_at: Date.now(),
			});

			// Schedule snapshot creation after 10 seconds of inactivity
			await schedule_snapshot(ctx, {
				page_id: page.page_id,
				workspace_id: args.workspaceId,
				project_id: args.projectId,
			});
		}

		return null;
	},
});

export const apply_patch_to_page_and_broadcast = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
		patch: v.string(),
		threadId: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.first();

		if (!page) {
			throw new Error("Page not found");
		}

		const currentText = page.text_content ?? "";
		const patches = parsePatch(args.patch);
		const [newText, results] = applyPatches(patches, currentText);

		if (!results.every(Boolean)) {
			throw new Error("Failed to apply all patches to the page text");
		}

		await ctx.db.patch(page._id, {
			text_content: newText,
			updated_by: user.name,
			updated_at: Date.now(),
		});

		const threadId = args.threadId;

		// If provided, clear the pending edit for this user/thread so future reads use the actual content
		if (threadId) {
			const existing = await ctx.db
				.query("ai_chat_pending_edits")
				.withIndex("by_user_thread_page", (q) =>
					q.eq("user_id", user.id).eq("thread_id", threadId).eq("page_id", args.pageId),
				)
				.first();

			if (existing) {
				await ctx.db.delete(existing._id);
			}
		}

		return null;
	},
});

export const get_page_by_path = query({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.union(
		v.object({
			workspace_id: v.union(v.string(), v.null()),
			project_id: v.union(v.string(), v.null()),
			page_id: v.string(),
			name: v.string(),
			is_archived: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const docId = await resolve_id_from_path(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			path: args.path,
		});

		if (!docId) return null;

		const page = await ctx.db
			.query("pages")
			.withIndex("by_id", (q) => q.eq("_id", docId))
			.first();

		return page
			? {
					workspace_id: page.workspace_id,
					project_id: page.project_id,
					page_id: page.page_id,
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
			.withIndex("by_parent_id_and_is_archived", (q) => q.eq("parent_id", nodeId).eq("is_archived", false))
			.collect();

		// TODO: do not collect
		const names = children.map((page) => page.name);
		return names;
	},
});

export const get_page_info_for_list_dir_pagination = internalQuery({
	args: {
		parentId: v.string(),
		cursor: paginationOptsValidator.fields.cursor,
	},
	handler: async (ctx, args) => {
		// TODO: do not use paginate
		const result = await ctx.db
			.query("pages")
			.withIndex("by_parent_id_and_is_archived", (q) => q.eq("parent_id", args.parentId).eq("is_archived", false))
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
						.withIndex("by_parent_id_and_is_archived", (q) =>
							q.eq("parent_id", frame.parentId).eq("is_archived", false),
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

export const get_page_text_content_by_path = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		userId: v.string(),
		threadId: v.string(),
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const docId = await resolve_id_from_path(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			path: args.path,
		});

		if (!docId) return null;

		const page = await ctx.db
			.query("pages")
			.withIndex("by_id", (q) => q.eq("_id", docId))
			.first();

		if (!page) return null;
		if (page.is_archived) return null;

		{
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
		}

		return page.text_content ?? null;
	},
});

async function do_get_page_text_content_by_page_id(
	ctx: QueryCtx,
	args: { workspaceId: string; projectId: string; pageId: string },
) {
	const page = await ctx.db
		.query("pages")
		.withIndex("by_workspace_project_and_page_id", (q) =>
			q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
		)
		.first();

	if (!page) return null;
	return page.text_content ?? null;
}
export const get_page_text_content_by_page_id = query({
	args: { workspaceId: v.string(), projectId: v.string(), pageId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		return await do_get_page_text_content_by_page_id(ctx, args);
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
			.query("pages")
			.withSearchIndex("search_text_content", (q) =>
				q.search("text_content", args.query).eq("workspace_id", args.workspaceId).eq("project_id", args.projectId),
			)
			.take(Math.max(1, Math.min(100, args.limit)));

		const visibleMatches = matches.filter((page) => !page.is_archived);

		const items: Array<{ path: string; preview: string }> = await Promise.all(
			visibleMatches.map(async (page): Promise<{ path: string; preview: string }> => {
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
				const preview = (pending?.modified_content ?? page.text_content).slice(0, 160);
				return { path, preview };
			}),
		);

		return { items };
	},
});

export const update_page_text_content = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
		textContent: v.string(),
	},
	returns: v.union(v.null(), v.object({ bad: v.object({ message: v.string() }) })),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		// Query pages table using page_id (formerly page_id)
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.first();

		if (!page) {
			return {
				bad: { message: "Page not found" },
			};
		}

		await ctx.db.patch(page._id, {
			text_content: args.textContent,
			updated_by: user.name,
			updated_at: Date.now(),
		});

		return null;
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
	returns: v.object({ page_id: v.string() }),
	handler: async (ctx, args) => {
		const { workspaceId, projectId } = args;
		const segments = server_path_extract_segments_from(args.path);
		let currentParent = pages_ROOT_ID;
		let lastPageId = pages_ROOT_ID;

		for (let i = 0; i < segments.length; i++) {
			const name = segments[i];

			// Does this segment exist?
			const existing = await ctx.db
				.query("pages")
				.withIndex("by_workspace_project_and_parent_id_and_name", (q) =>
					q.eq("workspace_id", workspaceId).eq("project_id", projectId).eq("parent_id", currentParent).eq("name", name),
				)
				.unique();

			if (!existing) {
				// Create missing segment
				const page_id = `page-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
				await create_page_in_db(ctx, {
					workspace_id: workspaceId,
					project_id: projectId,
					page_id,
					parent_id: currentParent,
					name: name,
					text_content: "",
				});
				currentParent = page_id;
				lastPageId = page_id;
			} else {
				// Continue traversal
				currentParent = existing.page_id;
				lastPageId = existing.page_id;

				// If it's the leaf and exists already, we should not create; caller decides overwrite path.
				if (i === segments.length - 1) {
					return { page_id: lastPageId };
				}
			}
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
			.withIndex("by_workspace_project_and_parent_id_and_name", (q) =>
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
		const page_id = `page-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await create_page_in_db(ctx, {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id,
			parent_id: pages_ROOT_ID,
			name: "",
			text_content: "",
		});

		return { page_id };
	},
});

const create_version_snapshot_body_schema = z.object({
	workspace_id: z.string(),
	project_id: z.string(),
	page_id: z.string(),
	content: z.string(),
});

export const create_version_snapshot = httpAction(async (ctx, request) => {
	try {
		const bodyResult = await server_request_json_parse_and_validate(request, create_version_snapshot_body_schema);

		if (bodyResult._nay) {
			return server_convex_response_error_client({
				body: bodyResult._nay,
				headers: server_convex_headers_cors(),
			});
		}

		const { workspace_id, project_id, page_id, content } = bodyResult._yay;

		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const snapshotId = await ctx.runMutation(internal.ai_docs_temp.store_version_snapshot, {
			workspace_id,
			project_id,
			page_id,
			content,
			created_by: user.name,
		});

		return new Response(JSON.stringify({ snapshotId }), {
			status: 200,
			headers: server_convex_headers_cors(),
		});
	} catch (error: unknown) {
		console.error("Version snapshot creation error:", error);
		return server_convex_response_error_server({
			body: {
				message: error instanceof Error ? error.message : "Internal server error",
			},
			headers: server_convex_headers_cors(),
		});
	}
});

// Shared helper for snapshot creation
const store_version_snapshot_args_schema = v.object({
	workspace_id: v.string(),
	project_id: v.string(),
	page_id: v.string(),
	content: v.string(),
	created_by: v.string(),
});

async function do_store_version_snapshot(ctx: MutationCtx, args: Infer<typeof store_version_snapshot_args_schema>) {
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

export const store_version_snapshot = internalMutation({
	args: store_version_snapshot_args_schema,
	returns: v.id("pages_snapshots"),
	handler: async (ctx, args) => {
		return await do_store_version_snapshot(ctx, args);
	},
});

export const create_snapshot_after_inactivity = internalMutation({
	args: {
		page_id: v.string(),
		workspace_id: v.string(),
		project_id: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		try {
			const user = await server_convex_get_user_fallback_to_anonymous(ctx);

			const textContent = await do_get_page_text_content_by_page_id(ctx, {
				workspaceId: args.workspace_id,
				projectId: args.project_id,
				pageId: args.page_id,
			});

			if (!textContent) {
				return null;
			}

			// Get the most recent non-archived snapshot for this page
			const lastSnapshot =
				(await ctx.db
					.query("pages_snapshots")
					.withIndex("by_page_id_and_is_archived", (q) => q.eq("page_id", args.page_id).eq("is_archived", undefined))
					.order("desc")
					.first()) ??
				(await ctx.db
					.query("pages_snapshots")
					.withIndex("by_page_id_and_is_archived", (q) => q.eq("page_id", args.page_id).eq("is_archived", false))
					.order("desc")
					.first());

			// If a snapshot exists, compare its content with the new content
			if (lastSnapshot) {
				const lastSnapshotContent = await do_get_page_snapshot_content(ctx, {
					page_id: args.page_id,
					page_snapshot_id: lastSnapshot._id,
				});

				// Skip creating a new snapshot if content hasn't changed
				if (lastSnapshotContent && lastSnapshotContent.content === textContent) {
					return null;
				}
			}

			await do_store_version_snapshot(ctx, {
				workspace_id: args.workspace_id,
				project_id: args.project_id,
				page_id: args.page_id,
				content: textContent,
				created_by: user.name,
			});

			return null;
		} finally {
			const schedule = await ctx.db
				.query("pages_snapshot_schedules")
				.withIndex("by_page_id", (q) => q.eq("page_id", args.page_id))
				.first();
			if (schedule) {
				await ctx.db.delete(schedule._id);
			}
		}
	},
});

export const get_page_snapshots_list = query({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.string(),
		show_archived: v.boolean(),
	},
	returns: v.array(
		v.object({
			_id: v.id("pages_snapshots"),
			_creationTime: v.number(),
			workspace_id: v.string(),
			project_id: v.string(),
			page_id: v.string(),
			created_by: v.string(),
			is_archived: v.optional(v.boolean()),
		}),
	),
	handler: async (ctx, args) => {
		const snapshots = await ctx.db
			.query("pages_snapshots")
			.withIndex("by_page_id", (q) => q.eq("page_id", args.page_id))
			.order("desc")
			.collect();

		return snapshots
			.filter((snapshot) => {
				if (args.show_archived) {
					return true;
				}
				return !snapshot.is_archived;
			})
			.map((snapshot) => ({
				_id: snapshot._id,
				_creationTime: snapshot._creationTime,
				workspace_id: snapshot.workspace_id,
				project_id: snapshot.project_id,
				page_id: snapshot.page_id,
				created_by: snapshot.created_by,
				is_archived: Boolean(snapshot.is_archived),
			}));
	},
});

async function do_get_page_snapshot_content(
	ctx: QueryCtx,
	args: { page_id: string; page_snapshot_id: Id<"pages_snapshots"> },
) {
	const content = await ctx.db
		.query("pages_snapshots_contents")
		.withIndex("by_page_id_and_snapshot_id", (q) =>
			q.eq("page_id", args.page_id).eq("page_snapshot_id", args.page_snapshot_id),
		)
		.first();

	if (!content) {
		return null;
	}

	const snapshot = await ctx.db.get(args.page_snapshot_id);
	if (!snapshot) {
		return null;
	}

	return {
		content: content.content,
		page_snapshot_id: content.page_snapshot_id,
		_creationTime: content._creationTime,
		created_by: snapshot.created_by,
	};
}

export const get_page_snapshot_content = query({
	args: {
		page_id: v.string(),
		page_snapshot_id: v.id("pages_snapshots"),
	},
	returns: v.union(
		v.object({
			content: v.string(),
			page_snapshot_id: v.id("pages_snapshots"),
			_creationTime: v.number(),
			created_by: v.string(),
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
		await ctx.db.patch(args.page_snapshot_id, {
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
		await ctx.db.patch(args.page_snapshot_id, {
			is_archived: false,
		});
	},
});

function to_array_buffer(u8: Uint8Array): ArrayBuffer {
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

async function write_markdown_to_yjs_sync(
	ctx: ActionCtx,
	args: {
		roomId: string;
		markdownContent: string;
		sessionId: string;
	},
): Promise<Result<{ _yay: null } | { _nay: { message: string } }>> {
	try {
		// Reconstruct the latest Y.Doc from Convex's head snapshot
		const emptyStateVector = encodeStateVector(new YDoc());
		const remote = await ctx.runQuery(api.yjs_sync.fetch_doc, {
			roomId: args.roomId,
			guid: null,
			clientStateVector: to_array_buffer(emptyStateVector),
		});

		const yDoc = new YDoc();
		applyUpdate(yDoc, new Uint8Array(remote.update));

		const beforeVector = encodeStateVector(yDoc);

		// Convert markdown to TipTap/ProseMirror JSON
		const editorDocJson = server_page_editor_markdown_to_json(args.markdownContent);

		if (editorDocJson._nay) {
			const msg = `Failed to parse markdown to TipTap/ProseMirror JSON: ${editorDocJson._nay.message}`;
			console.error(msg);
			return Result({ _nay: { message: msg } });
		}

		const schema = server_page_editor_get_schema();
		const fragment = yDoc.getXmlFragment(pages_YJS_DOC_KEYS.richText);
		const { meta } = initProseMirrorDoc(fragment, schema);
		const node = schema.nodeFromJSON(editorDocJson._yay);

		const yText = yDoc.getText(pages_YJS_DOC_KEYS.plainText);
		const currentText = yText.toString();

		yDoc.transact(() => {
			updateYFragment(yDoc, fragment, node, meta);

			if (currentText !== args.markdownContent) {
				const diff = simpleDiff(currentText, args.markdownContent);
				yText.delete(diff.index, diff.remove);
				yText.insert(diff.index, diff.insert);
			}
		}, "snapshot-restore");

		const diffUpdate = encodeStateAsUpdate(yDoc, beforeVector);

		if (diffUpdate.byteLength === 0) {
			return Result({ _yay: null });
		}

		await ctx.runMutation(api.yjs_sync.submit_update, {
			roomId: args.roomId,
			guid: null,
			update: to_array_buffer(diffUpdate),
			sessionId: args.sessionId,
		});

		return Result({ _yay: null });
	} catch (error) {
		const msg = `Failed to restore snapshot via Convex Yjs sync: ${(error as Error)?.message ?? error}`;
		console.error(msg);
		return Result({ _nay: { message: msg } });
	}
}

/**
 * Action to update page content and sync to Monaco editor via Yjs.
 * Replaces the broadcast mechanism - writes directly to Monaco's Yjs YText document.
 */
export const update_page_and_sync_to_monaco = action({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
		textContent: v.string(),
		sessionId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const roomId = ai_docs_create_liveblocks_room_id(args.workspaceId, args.projectId, args.pageId);

		await Promise.all([
			ctx.runMutation(internal.ai_docs_temp.internal_update_page_content, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				pageId: args.pageId,
				textContent: args.textContent,
			}),
			write_markdown_to_yjs_sync(ctx, {
				roomId,
				markdownContent: args.textContent,
				sessionId: args.sessionId,
			}),
		]);
	},
});

/**
 * Action to update page content and sync to Rich Text editor via Yjs.
 * Replaces the broadcast mechanism - writes directly to Rich Text's ProseMirror Yjs document.
 */
export const update_page_and_sync_to_richtext = action({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
		textContent: v.string(),
		sessionId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const roomId = ai_docs_create_liveblocks_room_id(args.workspaceId, args.projectId, args.pageId);

		await Promise.all([
			ctx.runMutation(internal.ai_docs_temp.internal_update_page_content, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				pageId: args.pageId,
				textContent: args.textContent,
			}),
			write_markdown_to_yjs_sync(ctx, {
				roomId,
				markdownContent: args.textContent,
				sessionId: args.sessionId,
			}),
		]);
	},
});

export const apply_snapshot_restore_in_convex = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
		pageSnapshotId: v.id("pages_snapshots"),
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
				page_id: args.pageId,
				page_snapshot_id: args.pageSnapshotId,
			}),
			ctx.db
				.query("pages")
				.withIndex("by_workspace_project_and_page_id", (q) =>
					q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
				)
				.first(),
		]);

		if (!snapshotContent) {
			const msg = "Snapshot content not found";
			console.error(msg);
			return Result({ _nay: { message: msg } });
		}

		if (!page) {
			const msg = "Page not found";
			console.error(msg);
			return Result({ _nay: { message: msg } });
		}

		const pageTextContent = page.text_content ?? "";

		await Promise.all([
			do_store_version_snapshot(ctx, {
				workspace_id: args.workspaceId,
				project_id: args.projectId,
				page_id: args.pageId,
				content: pageTextContent,
				created_by: user.name,
			}),

			do_store_version_snapshot(ctx, {
				workspace_id: args.workspaceId,
				project_id: args.projectId,
				page_id: args.pageId,
				content: snapshotContent.content,
				created_by: user.name,
			}),

			ctx.db.patch(page._id, {
				text_content: snapshotContent.content,
				updated_by: user.name,
				updated_at: Date.now(),
			}),
		]);

		return Result({ _yay: null });
	},
});

export const restore_snapshot = action({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
		pageSnapshotId: v.id("pages_snapshots"),
		sessionId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await Promise.all([
			ctx.runMutation(internal.ai_docs_temp.apply_snapshot_restore_in_convex, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				pageId: args.pageId,
				pageSnapshotId: args.pageSnapshotId,
			}),
			(async (/* iife */) => {
				const snapshotContent = await ctx.runQuery(api.ai_docs_temp.get_page_snapshot_content, {
					page_id: args.pageId,
					page_snapshot_id: args.pageSnapshotId,
				});

				if (!snapshotContent) {
					const msg = "Snapshot content not found";
					console.error(msg);
					return Result({ _nay: { message: msg } });
				}

				const roomId = ai_docs_create_liveblocks_room_id(args.workspaceId, args.projectId, args.pageId);
				const yjsSyncResult = await write_markdown_to_yjs_sync(ctx, {
					roomId,
					markdownContent: snapshotContent.content,
					sessionId: args.sessionId,
				});

				if (yjsSyncResult._nay) {
					console.error(`Failed to restore snapshot via Convex Yjs sync: ${yjsSyncResult._nay.message}`);
				}
			})(),
		]);
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
					// TODO: If we save the content id in the snapshot folder we can use the more efficient .get
					ctx.db
						.query("pages_snapshots_contents")
						.withIndex("by_page_snapshot_id", (q) => q.eq("page_snapshot_id", snapshot._id))
						.first()
						.then((content) => content && ctx.db.delete(content._id)),
					ctx.db.delete(snapshot._id),
				);
			}
		}

		await Promise.all(deletePromises);

		return null;
	},
});
