import { httpAction } from "./_generated/server";
import { streamText, smoothStream, createDataStreamResponse } from "ai";
import { openai } from "@ai-sdk/openai";
import { server_convex_get_user_fallback_to_anonymous, server_convex_headers_cors } from "./lib/server_convex_utils.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../src/lib/ai-chat.ts";
import { Liveblocks } from "@liveblocks/node";
import { Result } from "../src/lib/errors-as-values-utils.ts";

const LIVEBLOCKS_SECRET_KEY = process.env.LIVEBLOCKS_SECRET_KEY!;
if (!LIVEBLOCKS_SECRET_KEY) {
	throw new Error("LIVEBLOCKS_SECRET_KEY env var is not set");
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
