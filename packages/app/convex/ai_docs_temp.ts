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

// Mock Liveblocks auth for development
export const ai_docs_temp_liveblocks_auth = httpAction(async (ctx, request) => {
	// Mock auth response for development
	const mockAuth = {
		token: "mock_token_for_development",
		user: {
			id: "dev_user",
			info: {
				name: "Development User",
				avatar: "https://via.placeholder.com/32",
			},
		},
	};

	return new Response(JSON.stringify(mockAuth), {
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		},
	});
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
