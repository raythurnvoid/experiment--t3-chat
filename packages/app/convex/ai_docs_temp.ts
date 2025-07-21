import { httpAction } from "./_generated/server";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import * as z from "zod";

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
	try {
		// Get the secret key from environment variables
		const secretKey = process.env.LIVEBLOCKS_SECRET_KEY;

		if (!secretKey) {
			console.error("LIVEBLOCKS_SECRET_KEY is not configured");
			return new Response(JSON.stringify({ error: "Liveblocks not configured" }), {
				status: 500,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				},
			});
		}

		// Import Liveblocks server package
		const { Liveblocks } = await import("@liveblocks/node");

		const liveblocks = new Liveblocks({
			secret: secretKey,
		});

		// Generate a unique user ID for this session
		// In a real app, you'd get this from your authentication system
		const user_id = `user_${Math.random().toString(36).substring(2, 15)}`;

		// Create user info
		const user_info = {
			name: `User ${user_id.slice(-8)}`,
			avatar: "https://via.placeholder.com/32",
			color: "#" + Math.floor(Math.random() * 16777215).toString(16), // Random color
		};

		// Create a session for the current user
		const session = liveblocks.prepareSession(user_id, {
			userInfo: user_info,
		});

		// Allow access to all rooms for development
		// In production, you'd want to implement proper room-level permissions
		session.allow("*", session.FULL_ACCESS);

		// Authorize the user and return the result
		const { status, body } = await session.authorize();

		return new Response(body, {
			status,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type, Authorization",
			},
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
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				},
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
