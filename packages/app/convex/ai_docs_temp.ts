import { httpAction } from "./_generated/server";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import * as z from "zod";
import {
	server_convex_get_user_id_fallback_to_anonymous,
	server_convex_headers_cors,
} from "./lib/server_convex_utils.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../src/lib/ai-chat.ts";
import { auth_ANONYMOUS_USER_ID } from "../shared/shared_auth_constants.ts";
import { Liveblocks } from "@liveblocks/node";

// Response schema for AI contextual prompts
const ai_docs_temp_response_schema = z
	.object({
		type: z
			.enum(["insert", "replace", "other"])
			.describe(
				'The type of response: "insert" to add new text **after** the selection (e.g. "continue writing", "complete the sentence"), "replace" to modify the selection with new text (e.g. "fix the spelling", "translate to French", "make this paragraph longer"), "other" to respond with analysis, explanations, or summaries (e.g. "explain this paragraph", "what is this word?")',
			),
		text: z
			.string()
			.describe(
				"The text to insert or replace with, or the response to the query. If the request is unclear, ask for clarification.",
			),
	})
	.describe("Response to a contextual prompt based on selected text or cursor position");

// AI contextual prompt action for Tiptap editor
export const ai_docs_temp_contextual_prompt = httpAction(async (ctx, request) => {
	const body = await request.json();

	// Validate request body
	const { prompt, context } = body;

	if (!prompt || typeof prompt !== "string") {
		return new Response(JSON.stringify({ error: "Invalid prompt" }), {
			status: 400,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			},
		});
	}

	try {
		const { object } = await generateObject({
			model: openai("gpt-4o-mini"),
			schema: ai_docs_temp_response_schema,
			system: `You are an AI writing assistant. Help users with their writing by providing contextual suggestions.
      
      When given a prompt and context:
      - For "continue writing" or completion requests, use type "insert"
      - For editing, improving, or rewriting requests, use type "replace" 
      - For questions, explanations, or analysis, use type "other"
      
      Be concise and helpful. Focus on the specific request.`,
			prompt: `Context: ${context || "No context provided"}
      
      User request: ${prompt}`,
		});

		return new Response(JSON.stringify(object), {
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			},
		});
	} catch (error) {
		console.error("AI contextual prompt error:", error);
		return new Response(JSON.stringify({ error: "Failed to generate AI response" }), {
			status: 500,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			},
		});
	}
});

// Liveblocks authentication action
export const ai_docs_temp_liveblocks_auth = httpAction(async (ctx, request) => {
	let is_authenticated = false;
	let user_id;
	let secretKey;

	try {
		// Parse request body to get room parameter (sent from frontend)
		const request_body = await request.json().catch(() => ({}));
		const room_id = request_body.room || null;

		console.log("Liveblocks auth for room:", room_id);

		// Get the secret key from environment variables
		secretKey = process.env.LIVEBLOCKS_SECRET_KEY;

		if (!secretKey) {
			console.error("LIVEBLOCKS_SECRET_KEY is not configured");
			return new Response(JSON.stringify({ error: "Liveblocks not configured" }), {
				status: 500,
				headers: server_convex_headers_cors(),
			});
		}

		console.log("getting auth from convex");

		// Get user ID from existing auth system (Clerk or anonymous)
		user_id = await server_convex_get_user_id_fallback_to_anonymous(ctx);
		is_authenticated = user_id !== auth_ANONYMOUS_USER_ID;
	} catch (e) {
		console.error("Convex auth error:", e);
		return new Response(JSON.stringify({ error: "Authentication failed" }), {
			status: 500,
			headers: server_convex_headers_cors(),
		});
	}

	try {
		console.log("creating liveblocks");

		const liveblocks = new Liveblocks({
			secret: secretKey,
		});

		console.log("is_authenticated", is_authenticated);

		// Create user info based on auth status
		const user_info = is_authenticated
			? await (async (/* iife */) => {
					// For authenticated users, try to get user info from Clerk
					try {
						const identity = await ctx.auth.getUserIdentity();
						return {
							name: identity?.name || identity?.nickname || `User ${user_id.slice(-8)}`,
							avatar: identity?.pictureUrl || "https://via.placeholder.com/32",
							color: "#" + Math.floor(Math.random() * 16777215).toString(16), // Random color for now
						};
					} catch (error) {
						console.warn("Failed to get user info from Clerk:", error);
						return {
							name: `User ${user_id.slice(-8)}`,
							avatar: "https://via.placeholder.com/32",
							color: "#" + Math.floor(Math.random() * 16777215).toString(16),
						};
					}
				})()
			: {
					name: "Anonymous User",
					avatar: "https://via.placeholder.com/32",
					color: "#888888", // Gray color for anonymous users
				};

		console.log("user_info", user_info);

		// Create a session for access token authentication
		const session = liveblocks.prepareSession(user_id, {
			userInfo: user_info,
		});

		// Set up room access using naming pattern: <workspace_id>:<project_id>:<document_id>
		// For now, grant access to all documents in the hardcoded workspace/project
		const workspace_pattern = `${ai_chat_HARDCODED_ORG_ID}:${ai_chat_HARDCODED_PROJECT_ID}:*`;

		// Authenticated users get full access to their workspace/project
		session.allow(workspace_pattern, session.FULL_ACCESS);

		// Authorize the user and return the result
		const { status, body } = await session.authorize();

		console.log("authorize", body);

		return new Response(body, {
			status,
			headers: server_convex_headers_cors(),
		});
	} catch (error) {
		console.error("Liveblocks auth error:", error);
		return new Response(
			JSON.stringify({
				error: "Authentication failed",
				details: error instanceof Error ? error.message : "Unknown error",
			}),
			{
				status: 500,
				headers: server_convex_headers_cors(),
			},
		);
	}
});

// Mock users endpoint for Liveblocks
export const ai_docs_temp_users = httpAction(async (ctx, request) => {
	// Mock users response for development
	const mockUsers = [
		{
			id: "dev_user",
			name: "Development User",
			avatar: "https://via.placeholder.com/32",
		},
	];

	return new Response(JSON.stringify(mockUsers), {
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		},
	});
});
