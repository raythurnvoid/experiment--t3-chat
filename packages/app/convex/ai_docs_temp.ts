/*
Pages are organized in a emuted file system in which each page exists in a tree and each page can have children.

This structure allows file system like operations such has finding all items under a certain path (`foo/bar/*`) or
listing all children or the content of a certain page (`foo/bar/baz`).
*/

import { httpAction, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { streamText, smoothStream } from "ai";
import { openai } from "@ai-sdk/openai";
import {
	server_path_extract_segments_from,
	server_convex_get_user_fallback_to_anonymous,
	server_convex_headers_cors,
} from "./lib/server_utils.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../src/lib/ai-chat.ts";
import { Liveblocks } from "@liveblocks/node";
import { Result } from "../src/lib/errors-as-values-utils.ts";
import { v } from "convex/values";

const LIVEBLOCKS_SECRET_KEY = process.env.LIVEBLOCKS_SECRET_KEY!;
if (!LIVEBLOCKS_SECRET_KEY) {
	throw new Error("LIVEBLOCKS_SECRET_KEY env var is not set");
}

const LIVEBLOCKS_WEBHOOK_SECRET = process.env.LIVEBLOCKS_WEBHOOK_SECRET || "";
if (!LIVEBLOCKS_WEBHOOK_SECRET) {
	console.warn("LIVEBLOCKS_WEBHOOK_SECRET env var is not set");
}

export const contextual_prompt = httpAction(async (ctx, request) => {
	try {
		// Parse request body - expecting format: { prompt, option, command }
		const bodyResult = await Result.tryPromise(request.json());
		if (bodyResult.bad) {
			return new Response("Failed to parse request body", {
				status: 400,
				headers: server_convex_headers_cors(),
			});
		}

		const { prompt, option, command } = bodyResult.ok;

		if (!prompt || typeof prompt !== "string") {
			return new Response("Invalid prompt", {
				status: 400,
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
		return new Response(error instanceof Error ? error.message : "Internal server error", {
			status: 500,
			headers: server_convex_headers_cors(),
		});
	}
});

export const liveblocks_auth = httpAction(async (ctx, request) => {
	// Parse request body to get room parameter
	const requestBodyResult = await Result.tryPromise(request.json());
	if (requestBodyResult.bad) {
		return new Response(JSON.stringify({ message: "Failed to parse request body" }), {
			status: 400,
			headers: server_convex_headers_cors(),
		});
	}

	const liveblocks = new Liveblocks({
		secret: LIVEBLOCKS_SECRET_KEY,
	});

	const userResult = await server_convex_get_user_fallback_to_anonymous(ctx);

	// Create a session for access token authentication
	const sessionResult = Result.try(() =>
		liveblocks.prepareSession(userResult.id, {
			userInfo: {
				avatar: userResult.avatar,
				name: userResult.name,
			},
		}),
	);

	if (sessionResult.bad) {
		console.error("Failed to create session:", sessionResult.bad);
		return new Response(
			JSON.stringify({
				message: "Failed to create session",
			}),
			{
				status: 500,
				headers: server_convex_headers_cors(),
			},
		);
	}

	// Set up room access using naming pattern: <workspace_id>:<project_id>:<document_id>
	// For now, grant access to all documents in the hardcoded workspace/project
	const workspacePattern = `${ai_chat_HARDCODED_ORG_ID}:${ai_chat_HARDCODED_PROJECT_ID}:*`;
	sessionResult.ok.allow(workspacePattern, sessionResult.ok.FULL_ACCESS);
	const accessTokenResult = await Result.tryPromise(sessionResult.ok.authorize());
	if (accessTokenResult.bad) {
		console.error("Authorization failed:", accessTokenResult.bad);
		return new Response(
			JSON.stringify({
				message: "Authorization failed",
			}),
			{
				status: 500,
				headers: server_convex_headers_cors(),
			},
		);
	}

	if (accessTokenResult.ok.error) {
		console.error("Authorization returned an error:", accessTokenResult.ok.error);
		return new Response(JSON.stringify({ message: "Authorization returned an error" }), {
			status: 500,
			headers: server_convex_headers_cors(),
		});
	}

	return new Response(accessTokenResult.ok.body, {
		status: accessTokenResult.ok.status,
		headers: server_convex_headers_cors(),
	});
});

// @ts-ignore
async function verify_webhook_signature(
	body: string,
	webhookId: string,
	webhookTimestamp: string,
	webhookSignature: string,
	secret: string,
): Promise<boolean> {
	try {
		// Extract base64 part from whsec_... format
		const base64Secret = secret.startsWith("whsec_") ? secret.slice(6) : secret;

		// Decode the webhook secret
		const secretBytes = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0));

		// Create the signed content: {webhookId}.{webhookTimestamp}.{body}
		const signedContent = `${webhookId}.${webhookTimestamp}.${body}`;
		const encoder = new TextEncoder();
		const signedContentBytes = encoder.encode(signedContent);

		// Import secret key for HMAC
		const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

		// Compute HMAC
		const signature = await crypto.subtle.sign("HMAC", key, signedContentBytes);
		const computedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));

		// Parse webhook signature header (format: "v1,signature1 v1,signature2")
		const signatures = webhookSignature.split(" ");
		for (const sig of signatures) {
			const [version, providedSignature] = sig.split(",");
			if (version === "v1" && providedSignature === computedSignature) {
				return true;
			}
		}

		return false;
	} catch (error) {
		console.error("Webhook signature verification failed:", error);
		return false;
	}
}

// @ts-ignore
function is_timestamp_valid(timestampHeader: string): boolean {
	try {
		const webhookTimestamp = parseInt(timestampHeader, 10);
		const now = Math.floor(Date.now() / 1000);
		const tolerance = 5 * 60; // 5 minutes in seconds

		return Math.abs(now - webhookTimestamp) <= tolerance;
	} catch {
		return false;
	}
}

async function resolve_id_from_path(ctx: QueryCtx, args: { workspace_id: string; project_id: string; path: string }) {
	if (args.path === "/") return null;

	const segments = server_path_extract_segments_from(args.path);

	let docId = null;
	let currentNode = "root";

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
	args: { workspace_id: string; project_id: string; path: string },
) {
	const segments = server_path_extract_segments_from(args.path);

	let pageId = null;
	let currentNode = "root";

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
		pageId = page.page_id;
	}

	return pageId;
}

export const resolve_page_id_from_path = internalQuery({
	args: { workspace_id: v.string(), project_id: v.string(), path: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: (ctx, args) => resolve_page_id_from_path_fn(ctx, args),
});

async function resolve_tree_node_id_from_path_fn(
	ctx: QueryCtx,
	args: { workspace_id: string; project_id: string; path: string },
) {
	if (args.path === "/") return "root";
	const segments = server_path_extract_segments_from(args.path);

	let currentNode = "root";

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
	}

	return currentNode;
}

export const resolve_tree_node_id_from_path = internalQuery({
	args: { workspace_id: v.string(), project_id: v.string(), path: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: (ctx, args) => resolve_tree_node_id_from_path_fn(ctx, args),
});

async function resolve_path_from_page_id(
	ctx: QueryCtx,
	args: { workspace_id: string; project_id: string; page_id: string },
): Promise<string> {
	if (args.page_id === "root") return "/";
	const segments: string[] = [];
	let currentId: string | null = args.page_id;
	while (currentId && currentId !== "root") {
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

export const get_tree = query({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
	},
	returns: v.record(
		v.string(),
		v.object({
			index: v.string(),
			children: v.array(v.string()),
			title: v.string(),
			content: v.string(),
			isArchived: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		const pages = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project", (q) =>
				q.eq("workspace_id", args.workspace_id).eq("project_id", args.project_id),
			)
			.collect();

		// Build tree data in React Complex Tree format
		const treeData: Record<string, any> = {
			root: {
				index: "root",
				children: [],
				title: "Documents",
				content: "",
				isArchived: false,
			},
		};

		// Add all documents to tree using page_id as index
		for (const page of pages) {
			if (!page.page_id) continue; // Skip documents without page_id

			treeData[page.page_id] = {
				index: page.page_id,
				children: [],
				title: page.name || "Untitled",
				content: `<h1>${page.name || "Untitled"}</h1><p>Start writing your content here...</p>`,
				isArchived: page.is_archived || false,
			};
		}

		// Build parent-child relationships using doc_ids
		for (const page of pages) {
			if (treeData[page.parent_id] && treeData[page.page_id]) {
				treeData[page.parent_id].children.push(page.page_id);
			}
		}

		// Sort all children alphabetically by title
		for (const item of Object.values(treeData)) {
			if (item.children?.length > 0) {
				item.children.sort((a: string, b: string) => {
					const titleA = treeData[a]?.data?.title || "";
					const titleB = treeData[b]?.data?.title || "";
					return titleA.localeCompare(titleB, undefined, {
						numeric: true,
						sensitivity: "base",
					});
				});
			}
		}

		// Add placeholders for empty folders
		for (const [itemId, item] of Object.entries(treeData)) {
			if (!item.children || item.children.length === 0) {
				const placeholderId = `${itemId}-placeholder`;
				treeData[placeholderId] = {
					index: placeholderId,
					children: [],
					title: "No files inside",
					content: "",
					isArchived: false,
				};
				item.children = [placeholderId];
			}
		}

		return treeData;
	},
});

export const create_page = mutation({
	args: {
		page_id: v.string(),
		parent_id: v.string(),
		name: v.string(),
		workspace_id: v.string(),
		project_id: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const now = Date.now();

		await ctx.db.insert("pages", {
			workspace_id: args.workspace_id,
			project_id: args.project_id,
			page_id: args.page_id,
			parent_id: args.parent_id,
			text_content: "",
			version: 0,
			name: args.name,
			is_archived: false,
			created_by: user.name,
			updated_by: user.name,
			created_at: now,
			updated_at: now,
		});
	},
});

export const rename_page = mutation({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.string(),
		name: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspace_id).eq("project_id", args.project_id).eq("page_id", args.page_id),
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
		item_ids: v.array(v.string()),
		target_parent_id: v.string(),
		workspace_id: v.string(),
		project_id: v.string(),
	},
	handler: async (ctx, args) => {
		for (const item_id of args.item_ids) {
			const page = await ctx.db
				.query("pages")
				.withIndex("by_workspace_project_and_page_id", (q) =>
					q.eq("workspace_id", args.workspace_id).eq("project_id", args.project_id).eq("page_id", item_id),
				)
				.first();

			if (page) {
				await ctx.db.patch(page._id, {
					workspace_id: args.workspace_id,
					project_id: args.project_id,
					parent_id: args.target_parent_id,
					updated_at: Date.now(),
				});
			}
		}
	},
});

export const archive_pages = mutation({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspace_id).eq("project_id", args.project_id).eq("page_id", args.page_id),
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
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspace_id).eq("project_id", args.project_id).eq("page_id", args.page_id),
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

export const get_page_by_path = query({
	args: { workspace_id: v.string(), project_id: v.string(), path: v.string() },
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
			workspace_id: args.workspace_id,
			project_id: args.project_id,
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
		workspace_id: v.string(),
		project_id: v.string(),
		path: v.string(),
	},
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		const nodeId = await resolve_tree_node_id_from_path_fn(ctx, {
			workspace_id: args.workspace_id,
			project_id: args.project_id,
			path: args.path,
		});
		if (!nodeId) return [];

		const children = await ctx.db
			.query("pages")
			.withIndex("by_parent_id", (q) => q.eq("parent_id", nodeId))
			.collect();

		const names = children.map((page) => page.name);
		return names;
	},
});

export const get_page_info_for_list_dir_pagination = internalQuery({
	args: {
		parent_id: v.string(),
		cursor: paginationOptsValidator.fields.cursor,
	},
	handler: async (ctx, args) => {
		const result = await ctx.db
			.query("pages")
			.withIndex("by_parent_id", (q) => q.eq("parent_id", args.parent_id))
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

export const page_exists_by_path = internalQuery({
	args: { workspace_id: v.string(), project_id: v.string(), path: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const pageId = await resolve_page_id_from_path_fn(ctx, {
			workspace_id: args.workspace_id,
			project_id: args.project_id,
			path: args.path,
		});
		if (!pageId) return false;

		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspace_id).eq("project_id", args.project_id).eq("page_id", pageId),
			)
			.first();

		if (!page) return false;
		if (page.workspace_id !== args.workspace_id || page.project_id !== args.project_id) return false;
		return true;
	},
});

export const get_page_text_content_by_path = internalQuery({
	args: { workspace_id: v.string(), project_id: v.string(), path: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const docId = await resolve_id_from_path(ctx, {
			workspace_id: args.workspace_id,
			project_id: args.project_id,
			path: args.path,
		});

		if (!docId) return null;

		const page = await ctx.db
			.query("pages")
			.withIndex("by_id", (q) => q.eq("_id", docId))
			.first();

		if (!page) return null;

		return page.text_content ?? null;
	},
});

export const get_page_text_content_by_page_id = query({
	args: { workspace_id: v.string(), project_id: v.string(), page_id: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspace_id).eq("project_id", args.project_id).eq("page_id", args.page_id),
			)
			.first();

		if (!page) return null;
		return page.text_content ?? null;
	},
});

export const text_search_pages = internalQuery({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		query: v.string(),
		limit: v.number(),
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
				q.search("text_content", args.query).eq("workspace_id", args.workspace_id).eq("project_id", args.project_id),
			)
			.take(Math.max(1, Math.min(100, args.limit)));

		const items: Array<{ path: string; preview: string }> = await Promise.all(
			matches.map(async (page): Promise<{ path: string; preview: string }> => {
				const path: string = await resolve_path_from_page_id(ctx, {
					workspace_id: args.workspace_id,
					project_id: args.project_id,
					page_id: page.page_id,
				});
				const preview = page.text_content.slice(0, 160);
				return { path, preview };
			}),
		);

		return { items };
	},
});

export const update_page_text_content = mutation({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.string(),
		text_content: v.string(),
	},
	returns: v.union(v.null(), v.object({ bad: v.object({ message: v.string() }) })),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		// Query pages table using page_id (formerly page_id)
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace_project_and_page_id", (q) =>
				q.eq("workspace_id", args.workspace_id).eq("project_id", args.project_id).eq("page_id", args.page_id),
			)
			.first();

		if (!page) {
			return {
				bad: { message: "Page not found" },
			};
		}

		await ctx.db.patch(page._id, {
			text_content: args.text_content,
			updated_by: user.name,
			updated_at: Date.now(),
		});

		return null;
	},
});
