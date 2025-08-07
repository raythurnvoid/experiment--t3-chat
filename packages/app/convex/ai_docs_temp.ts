/*
Pages are organized in a emuted file system in which each page exists in a tree and each page can have children.

This structure allows file system like operations such has finding all items under a certain path (`foo/bar/*`) or
listing all children or the content of a certain page (`foo/bar/baz`).
*/

import { httpAction, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import { streamText, smoothStream, createDataStreamResponse } from "ai";
import { openai } from "@ai-sdk/openai";
import { server_convex_get_user_fallback_to_anonymous, server_convex_headers_cors } from "./lib/server_convex_utils.ts";
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

// AI generation endpoint for novel editor (compatible with useCompletion)
export const ai_docs_temp_contextual_prompt = httpAction(async (ctx, request) => {
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

		// Generate streaming completion using createDataStreamResponse (following ai_chat.ts pattern)
		const response = createDataStreamResponse({
			execute: async (dataStream) => {
				const result = streamText({
					model: openai("gpt-4o-mini"),
					system: systemPrompt,
					messages: [
						{
							role: "user",
							content: userPrompt,
						},
					],
					temperature: 0.7,
					maxTokens: 500,
					experimental_transform: smoothStream({
						delayInMs: 100,
					}),
				});

				result.mergeIntoDataStream(dataStream);
			},
			onError: (error) => {
				console.error("AI generation error:", error);
				return error instanceof Error ? error.message : String(error);
			},
			headers: server_convex_headers_cors(),
		});

		return response;
	} catch (error: unknown) {
		console.error("AI generation error:", error);
		return new Response(error instanceof Error ? error.message : "Internal server error", {
			status: 500,
			headers: server_convex_headers_cors(),
		});
	}
});

// Liveblocks authentication action
export const ai_docs_temp_liveblocks_auth = httpAction(async (ctx, request) => {
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

export const ai_docs_temp_upsert_yjs_document = mutation({
	args: {
		doc_id: v.string(),
		yjs_document_state: v.string(),
	},
	returns: v.object({
		action: v.string(),
		id: v.id("docs_yjs"),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		// Check if document exists
		const existingDoc = await ctx.db
			.query("docs_yjs")
			.withIndex("by_doc_id", (q) => q.eq("doc_id", args.doc_id))
			.first();

		if (existingDoc) {
			// Update existing document
			await ctx.db.patch(existingDoc._id, {
				yjs_document_state: args.yjs_document_state,
				version: (existingDoc.version || 0) + 1,
				updated_at: Date.now(),
			});
			return { action: "updated", id: existingDoc._id };
		} else {
			// Create new document with metadata
			const newId = await ctx.db.insert("docs_yjs", {
				yjs_document_state: args.yjs_document_state,
				version: 0,
				doc_id: args.doc_id,
				title: "Untitled Document", // Default title
				is_archived: false,
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				created_by: user.name,
				updated_by: user.name,
				created_at: Date.now(),
				updated_at: Date.now(),
			});

			return { action: "created", id: newId };
		}
	},
});

// HTTP action to handle Liveblocks webhooks
export const ai_docs_temp_liveblocks_webhook = httpAction(async (ctx, request) => {
	try {
		// Verify request method
		if (request.method !== "POST") {
			return new Response("Method not allowed", {
				status: 405,
				headers: server_convex_headers_cors(),
			});
		}

		// Get headers
		const webhookId = request.headers.get("webhook-id");
		const webhookTimestamp = request.headers.get("webhook-timestamp");
		const webhookSignature = request.headers.get("webhook-signature");

		if (!webhookId || !webhookTimestamp || !webhookSignature) {
			console.error("Missing webhook headers");
			return new Response("Missing webhook headers", {
				status: 400,
				headers: server_convex_headers_cors(),
			});
		}

		// Get raw body
		const body = await request.text();

		// Verify timestamp
		if (!is_timestamp_valid(webhookTimestamp)) {
			console.error("Webhook timestamp is too old or invalid");
			return new Response("Invalid timestamp", {
				status: 400,
				headers: server_convex_headers_cors(),
			});
		}

		// Verify signature
		const isValidSignature = await verify_webhook_signature(
			body,
			webhookId,
			webhookTimestamp,
			webhookSignature,
			LIVEBLOCKS_WEBHOOK_SECRET,
		);

		if (!isValidSignature) {
			console.error("Invalid webhook signature");
			return new Response("Invalid signature", {
				status: 401,
				headers: server_convex_headers_cors(),
			});
		}

		// Parse the webhook payload
		const payload = JSON.parse(body) as { type: "ydocUpdated"; data: { roomId: string; updatedAt: string } };
		console.log("Received Liveblocks webhook:", payload.type, payload.data);

		// Handle ydocUpdated events
		if (payload.type === "ydocUpdated") {
			const { roomId } = payload.data;

			try {
				// Extract doc_id from roomId (format: workspace:project:doc_id)
				const parts = roomId.split(":");
				const doc_id = parts[2];

				if (!doc_id) {
					console.error("Invalid roomId format - cannot extract doc_id:", roomId);
					return new Response("Invalid roomId format", {
						status: 400,
						headers: server_convex_headers_cors(),
					});
				}

				// Fetch the Yjs document from Liveblocks REST API
				const yjsResponse = await fetch(`https://api.liveblocks.io/v2/rooms/${roomId}/ydoc`, {
					headers: {
						Authorization: `Bearer ${LIVEBLOCKS_SECRET_KEY}`,
					},
				});

				if (!yjsResponse.ok) {
					console.error("Failed to fetch Yjs document from Liveblocks:", yjsResponse.status);
					return new Response("Failed to fetch document", {
						status: 500,
						headers: server_convex_headers_cors(),
					});
				}

				// Get the Yjs document as base64-encoded binary data
				const yjsBuffer = await yjsResponse.arrayBuffer();
				const yjsBase64 = btoa(String.fromCharCode(...new Uint8Array(yjsBuffer)));

				// Persist to Convex using doc_id
				await ctx.runMutation(api.ai_docs_temp.ai_docs_temp_upsert_yjs_document, {
					doc_id,
					yjs_document_state: yjsBase64,
				});

				console.log(`Successfully persisted Yjs document for doc_id: ${doc_id}`);
			} catch (error) {
				console.error("Error processing ydocUpdated webhook:", error);
				return new Response("Error processing webhook", {
					status: 500,
					headers: server_convex_headers_cors(),
				});
			}
		}

		// Return success response
		return new Response("OK", {
			status: 200,
			headers: server_convex_headers_cors(),
		});
	} catch (error) {
		console.error("Webhook handler error:", error);
		return new Response("Internal server error", {
			status: 500,
			headers: server_convex_headers_cors(),
		});
	}
});

// Helper function to get user (implement based on your auth system)
async function getCurrentUser(ctx: any) {
	return { id: "system" }; // Replace with actual auth logic
}

// Get entire tree structure for workspace/project
export const ai_docs_temp_get_document_tree = query({
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
		// Get all documents for this workspace/project
		const docs = await ctx.db
			.query("docs_yjs")
			.withIndex("by_workspace_project", (q) =>
				q.eq("workspace_id", args.workspace_id).eq("project_id", args.project_id),
			)
			.collect();

		// Get tree structure relationships
		const structure = await ctx.db
			.query("file_tree")
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

		// Add all documents to tree using doc_id as index
		for (const doc of docs) {
			if (!doc.doc_id) continue; // Skip documents without doc_id

			treeData[doc.doc_id] = {
				index: doc.doc_id,
				children: [],
				title: doc.title || "Untitled",
				content: `<h1>${doc.title || "Untitled"}</h1><p>Start writing your content here...</p>`,
				isArchived: doc.is_archived || false,
			};
		}

		// Build parent-child relationships using doc_ids
		for (const rel of structure) {
			if (treeData[rel.parent_id] && treeData[rel.child_id]) {
				treeData[rel.parent_id].children.push(rel.child_id);
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

export const ai_docs_temp_create_document = mutation({
	args: {
		doc_id: v.string(),
		parent_id: v.string(),
		title: v.string(),
		workspace_id: v.string(),
		project_id: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await getCurrentUser(ctx);
		const now = Date.now();

		// Create document in docs_yjs table
		await ctx.db.insert("docs_yjs", {
			yjs_document_state: "", // Empty initial state
			version: 0,
			title: args.title,
			is_archived: false,
			workspace_id: args.workspace_id,
			project_id: args.project_id,
			doc_id: args.doc_id,
			created_by: user.id,
			updated_by: user.id,
			created_at: now,
			updated_at: now,
		});

		// Add to tree structure using doc_id
		await ctx.db.insert("file_tree", {
			workspace_id: args.workspace_id,
			project_id: args.project_id,
			parent_id: args.parent_id,
			child_id: args.doc_id,
			name: args.title,
		});
	},
});

export const ai_docs_temp_rename_document = mutation({
	args: {
		doc_id: v.string(),
		title: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await getCurrentUser(ctx);

		const doc = await ctx.db
			.query("docs_yjs")
			.withIndex("by_doc_id", (q) => q.eq("doc_id", args.doc_id))
			.first();

		if (doc) {
			await ctx.db.patch(doc._id, {
				title: args.title,
				updated_by: user.id,
				updated_at: Date.now(),
			});
		}

		const treeItem = await ctx.db
			.query("file_tree")
			.withIndex("by_child", (q) => q.eq("child_id", args.doc_id))
			.first();

		if (treeItem) {
			await ctx.db.patch(treeItem._id, {
				name: args.title,
			});
		}
	},
});

export const ai_docs_temp_move_items = mutation({
	args: {
		item_ids: v.array(v.string()), // doc_ids
		target_parent_id: v.string(),
		workspace_id: v.string(),
		project_id: v.string(),
	},
	handler: async (ctx, args) => {
		for (const item_id of args.item_ids) {
			const existing = await ctx.db
				.query("file_tree")
				.withIndex("by_child", (q) => q.eq("child_id", item_id))
				.first();

			if (existing) {
				await ctx.db.patch(existing._id, {
					workspace_id: args.workspace_id,
					project_id: args.project_id,
					parent_id: args.target_parent_id,
					child_id: item_id,
					name: existing.name,
				});
			}
		}
	},
});

export const ai_docs_temp_archive_document = mutation({
	args: {
		doc_id: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await getCurrentUser(ctx);

		const doc = await ctx.db
			.query("docs_yjs")
			.withIndex("by_doc_id", (q) => q.eq("doc_id", args.doc_id))
			.first();

		if (doc) {
			await ctx.db.patch(doc._id, {
				is_archived: true,
				updated_by: user.id,
				updated_at: Date.now(),
			});
		}
	},
});

export const ai_docs_temp_unarchive_document = mutation({
	args: {
		doc_id: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await getCurrentUser(ctx);

		const doc = await ctx.db
			.query("docs_yjs")
			.withIndex("by_doc_id", (q) => q.eq("doc_id", args.doc_id))
			.first();

		if (doc) {
			await ctx.db.patch(doc._id, {
				is_archived: false,
				updated_by: user.id,
				updated_at: Date.now(),
			});
		}
	},
});

export const ai_docs_temp_get_document_by_id = query({
	args: { doc_id: v.string() },
	returns: v.union(
		v.object({
			doc_id: v.string(),
			title: v.string(),
			is_archived: v.boolean(),
			workspace_id: v.union(v.string(), v.null()),
			project_id: v.union(v.string(), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const doc = await ctx.db
			.query("docs_yjs")
			.withIndex("by_doc_id", (q) => q.eq("doc_id", args.doc_id))
			.first();

		return doc
			? {
					doc_id: doc.doc_id!,
					title: doc.title || "Untitled",
					is_archived: doc.is_archived || false,
					workspace_id: doc.workspace_id || null,
					project_id: doc.project_id || null,
				}
			: null;
	},
});

export const ai_docs_temp_delete_document = mutation({
	args: {
		doc_id: v.string(),
	},
	handler: async (ctx, args) => {
		// Remove from docs_yjs
		const doc = await ctx.db
			.query("docs_yjs")
			.withIndex("by_doc_id", (q) => q.eq("doc_id", args.doc_id))
			.first();

		if (doc) {
			await ctx.db.delete(doc._id);
		}

		// Remove from file_tree
		const treeItem = await ctx.db
			.query("file_tree")
			.withIndex("by_child", (q) => q.eq("child_id", args.doc_id))
			.first();

		if (treeItem) {
			await ctx.db.delete(treeItem._id);
		}
	},
});

export const ai_docs_temp_get_document_by_path = query({
	args: { workspace_id: v.string(), project_id: v.string(), path: v.string() },
	returns: v.union(
		v.object({
			doc_id: v.string(),
			title: v.string(),
			is_archived: v.boolean(),
			workspace_id: v.union(v.string(), v.null()),
			project_id: v.union(v.string(), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const normalizedPath = args.path.replaceAll("\\", "/");
		const pathSegments = normalizedPath.split("/").filter(Boolean);

		let currentParent = "root";
		for (const segment of pathSegments) {
			const row = await ctx.db
				.query("file_tree")
				.withIndex("by_parent_and_name", (q) => q.eq("parent_id", currentParent).eq("name", segment))
				.unique();
			if (!row) return null; // segment not found
			currentParent = row.child_id; // descend
		}

		const doc = await ctx.db
			.query("docs_yjs")
			.withIndex("by_doc_id", (q) => q.eq("doc_id", currentParent))
			.first();

		return doc
			? {
					doc_id: doc.doc_id!,
					title: doc.title,
					is_archived: doc.is_archived,
					workspace_id: doc.workspace_id,
					project_id: doc.project_id,
				}
			: null;
	},
});
