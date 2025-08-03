import { httpAction, mutation } from "./_generated/server";
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

// Mutation to persist Yjs document to Convex
export const ai_docs_temp_upsert_yjs_document = mutation({
	args: {
		roomId: v.string(),
		yjsDocumentState: v.string(),
	},
	handler: async (ctx, args) => {
		const existingDoc = await ctx.db
			.query("docs_yjs")
			.withIndex("by_roomId", (q) => q.eq("roomId", args.roomId))
			.first();

		const docData = {
			roomId: args.roomId,
			yjsDocumentState: args.yjsDocumentState,
			lastUpdatedAt: Date.now(),
			version: 0, // Always save version 0 for now until versioning is implemented
		};

		if (existingDoc) {
			await ctx.db.patch(existingDoc._id, docData);
			return { action: "updated", id: existingDoc._id };
		} else {
			const newId = await ctx.db.insert("docs_yjs", docData);
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

				// Persist to Convex
				await ctx.runMutation(api.ai_docs_temp.ai_docs_temp_upsert_yjs_document, {
					roomId,
					yjsDocumentState: yjsBase64,
				});

				console.log(`Successfully persisted Yjs document for room: ${roomId}`);
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
