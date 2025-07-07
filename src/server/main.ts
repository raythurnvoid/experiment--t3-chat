// Must be first import
import "./server_env.ts";

import { openai } from "@ai-sdk/openai";
import { serve } from "@hono/node-server";
import {
	formatDataStreamPart,
	streamText,
	tool,
	smoothStream,
	createDataStream,
	type CoreMessage,
} from "ai";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createArtifactArgsSchema } from "../types/artifact-schemas";
import { randomUUID } from "node:crypto";
import { stream } from "hono/streaming";
import {
	ai_chat_HARDCODED_WORKSPACE_ID,
	type ai_chat_Message,
	type ai_chat_Thread,
} from "../lib/ai_chat.ts";
import type { ReadonlyJSONObject } from "@assistant-ui/assistant-stream/utils";
import {
	auth_ANONYMOUS_USER_ID,
	auth_ANONYMOUS_WORKSPACE_ID,
} from "../lib/auth.ts";
import { createClerkClient } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import {
	server_auth_get_user_id,
	server_auth_get_user_is_authenticated,
	server_auth_set_anonymous_user_in_context,
} from "./server_auth.ts";
import { AssistantCloud } from "@assistant-ui/react";

// TypeScript interfaces for compile-time type safety
interface ChatRequest {
	messages: CoreMessage[];
	[key: string]: unknown; // Allow additional properties
}

// Thread title generation request types
interface ThreadTitleRequest {
	thread_id: string;
	assistant_id: string;
	messages: ReadonlyJSONObject[];
}

const chatRequestSchema = z.object({
	messages: z.array(z.any()), // CoreMessage[] - flexible runtime, but TS typed above
	// In Zod v4, additional properties are handled through TypeScript interface above
});

interface ThreadData {
	meta: ai_chat_Thread;
	messages: ai_chat_Message[];
}

const threads = new Map<string, ThreadData>();

// Initialize Clerk client
const clerk_client = createClerkClient({
	secretKey: process.env.CLERK_SECRET_KEY,
	publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

function setAuthenticatedUserInRequestContext(
	c: Context,
	values: {
		userId: string;
		sessionId: string;
		isAuthenticated: boolean;
	}
) {
	if (values.isAuthenticated) {
		c.set("userId", values.userId);
		c.set("sessionId", values.sessionId);
		c.set("isAuthenticated", values.isAuthenticated);
	}
}

// Auth middleware that supports both Clerk users and anonymous users
const authMiddleware = createMiddleware(async (c, next) => {
	try {
		// Try to get token from Authorization header or body
		const auth_header = c.req.header("Authorization");
		const token = auth_header?.slice(auth_header.indexOf("Bearer ") + 7); // Remove "Bearer " prefix

		if (token && token !== "anonymous" && !token.startsWith("anon.")) {
			// Try to verify Clerk token
			try {
				const request = c.req.raw;
				const auth_result = await clerk_client.authenticateRequest(request, {
					jwtKey: process.env.CLERK_JWT_KEY,
					authorizedParties: ["http://localhost:5173", "http://localhost:3000"],
				});

				if (auth_result.isAuthenticated) {
					// Set authenticated user context
					const auth = auth_result.toAuth();
					setAuthenticatedUserInRequestContext(c, {
						userId: auth.userId,
						sessionId: auth.sessionId,
						isAuthenticated: true,
					});
				} else {
					// Invalid token, fall back to anonymous
					console.warn(
						"Clerk `authenticateRequest` returned not authenticated:",
						auth_result
					);
					server_auth_set_anonymous_user_in_context(c);
				}
			} catch (error) {
				// Fall back to anonymous user
				console.warn("Clerk `authenticateRequest` failed:", error);
				server_auth_set_anonymous_user_in_context(c);
			}
		} else {
			// No token or anonymous token - use anonymous user
			server_auth_set_anonymous_user_in_context(c);
		}

		await next();
	} catch (error) {
		console.error("Auth middleware error:", error);
		// Fall back to anonymous
		c.set("userId", auth_ANONYMOUS_USER_ID);
		c.set("isAuthenticated", false);
		await next();
	}
});

function isError(error: unknown): error is Error & {
	statusCode?: number;
	responseBody?: string;
	responseHeaders?: Record<string, unknown>;
	cause?: unknown;
} {
	return error instanceof Error;
}

const app = new Hono();

// Configure CORS middleware
app.use(
	"*",
	cors({
		origin: (origin) => {
			const allowedOrigins = ["http://localhost:5173", "http://localhost:3000"];
			return allowedOrigins.includes(origin) ? origin : null;
		},
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
	})
);

// Apply auth middleware to all routes
app.use("*", authMiddleware);

app.get("/", (c) => {
	return c.json({ message: "Hello from Hono server!" });
});

app.get("/api/health", (c) => {
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/v1/auth/tokens/anonymous", async (c) => {
	const now = new Date();
	const accessTokenExpiry = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
	const refreshTokenExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

	const accessTokenData = {
		sub: auth_ANONYMOUS_USER_ID,
		iat: Math.floor(now.getTime() / 1000),
		exp: Math.floor(accessTokenExpiry.getTime() / 1000),
	};

	const refreshTokenData = {
		sub: auth_ANONYMOUS_USER_ID,
		iat: Math.floor(now.getTime() / 1000),
		exp: Math.floor(refreshTokenExpiry.getTime() / 1000),
		type: "refresh",
	};

	const accessToken = `anon.${btoa(JSON.stringify(accessTokenData))}`;
	const refreshToken = `refresh.${btoa(JSON.stringify(refreshTokenData))}`;

	return c.json({
		access_token: accessToken,
		refresh_token: {
			token: refreshToken,
			expires_at: refreshTokenExpiry.toISOString(),
		},
	});
});

app.post("/api/v1/auth/tokens/refresh", async (c) => {
	const now = new Date();
	const accessTokenExpiry = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
	const refreshTokenExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

	const accessTokenData = {
		sub: auth_ANONYMOUS_USER_ID,
		iat: Math.floor(now.getTime() / 1000),
		exp: Math.floor(accessTokenExpiry.getTime() / 1000),
	};

	const refreshTokenData = {
		sub: auth_ANONYMOUS_USER_ID,
		iat: Math.floor(now.getTime() / 1000),
		exp: Math.floor(refreshTokenExpiry.getTime() / 1000),
		type: "refresh",
	};

	const accessToken = `anon.${btoa(JSON.stringify(accessTokenData))}`;
	const newRefreshToken = `refresh.${btoa(JSON.stringify(refreshTokenData))}`;

	return c.json({
		access_token: accessToken,
		refresh_token: {
			token: newRefreshToken,
			expires_at: refreshTokenExpiry.toISOString(),
		},
	});
});

app.get("/api/v1/threads", (c) => {
	const threadList = Array.from(threads.values()).map((thread) => ({
		...thread.meta,
		metadata: null,
	}));

	threadList.forEach((thread, idx) => {
		console.log(`  ${idx}: ${thread.id} - "${thread.title}"`);
	});

	return c.json({ threads: threadList });
});

app.post("/api/v1/threads", async (c) => {
	const body = await c.req.json();
	const threadId = `thread_${randomUUID().replace(/-/g, "").substring(0, 24)}`;

	console.log(
		`🆕 Creating new thread: ${threadId} with title: "${body.title || "New Chat"}"`
	);

	const now = new Date();
	const newThread: ThreadData = {
		meta: {
			id: threadId,
			title: body.title || "New Chat",
			is_archived: false,
			created_at: now.toISOString(),
			updated_at: now.toISOString(),
			last_message_at: now,
			workspace_id: ai_chat_HARDCODED_WORKSPACE_ID,
			metadata: {
				updated_by: auth_ANONYMOUS_USER_ID,
				created_by: auth_ANONYMOUS_USER_ID,
			},
			external_id: null,
			project_id: "project_123",
		},
		messages: [],
	};

	threads.set(threadId, newThread);

	console.log(`✅ Thread created successfully: ${threadId}`);
	console.log(`📊 Total threads now: ${threads.size}`);

	return c.json({ thread_id: threadId });
});

app.put("/api/v1/threads/:threadId", async (c) => {
	const threadId = c.req.param("threadId");
	const body = await c.req.json();

	const thread = threads.get(threadId);
	if (!thread) {
		return c.json({ error: "Thread not found" }, 404);
	}

	if (body.title !== undefined) {
		thread.meta.title = body.title;
	}
	if (body.is_archived !== undefined) {
		thread.meta.is_archived = body.is_archived;
	}

	thread.meta.updated_at = new Date().toISOString();
	thread.meta.metadata.updated_by = auth_ANONYMOUS_USER_ID;

	threads.set(threadId, thread);

	return c.json({}, 200);
});

app.delete("/api/v1/threads/:threadId", (c) => {
	const threadId = c.req.param("threadId");

	if (!threads.has(threadId)) {
		return c.json({ error: "Thread not found" }, 404);
	}

	threads.delete(threadId);

	return c.json({}, 200);
});

app.get("/api/v1/threads/:threadId/messages", (c) => {
	const threadId = c.req.param("threadId");
	console.log(`📨 Fetching messages for thread: ${threadId}`);

	const thread = threads.get(threadId);
	if (!thread) {
		console.log(`❌ Thread not found: ${threadId}`);
		return c.json({ error: "Thread not found" }, 404);
	}

	return c.json({
		messages: thread.messages,
	});
});

app.post("/api/v1/threads/:threadId/messages", async (c) => {
	const threadId = c.req.param("threadId");
	const body = await c.req.json();

	const thread = threads.get(threadId);
	if (!thread) {
		console.log(`❌ Thread not found: ${threadId}`);
		return c.json({ error: "Thread not found" }, 404);
	}

	const messageId = generateShortId();
	const now = new Date();

	// Create message in exact cloud format
	const assistantMessage: ai_chat_Message = {
		id: messageId,
		parent_id: body.parent_id || null,
		thread_id: threadId,
		created_by: auth_ANONYMOUS_USER_ID,
		created_at: now.toISOString(),
		updated_by: auth_ANONYMOUS_USER_ID,
		updated_at: now.toISOString(),
		format: "aui/v0",
		content: body.content,
		height:
			((body.content && body.content.role) || body.role) === "user" ? 0 : 1,
	};

	thread.messages.unshift(assistantMessage);
	thread.meta.last_message_at = now;
	thread.meta.updated_at = now.toISOString();
	threads.set(threadId, thread);

	return c.json({ message_id: messageId });
});

app.post("/api/v1/runs/stream", async (c) => {
	try {
		const body = (await c.req.json()) as ThreadTitleRequest;

		if (body.assistant_id === "system/thread_title") {
			const messages = body.messages || [];
			const threadId = body.thread_id;

			// Check if thread exists
			const thread = threads.get(threadId);
			if (!thread) {
				console.log(`❌ Thread not found for title generation: ${threadId}`);
				return c.json({ error: "Thread not found" }, 404);
			}

			// Extract conversation text from messages for title generation
			const conversationText = messages
				.map((msg) =>
					[
						`${msg.role}:`,
						Array.isArray(msg.content)
							? msg.content.map((part) => part.text).join(" ")
							: msg.content,
					]
						.filter(Boolean)
						.join(" ")
				)
				.filter(Boolean)
				.join("\n");

			// Generate title using AI with streaming
			const result = streamText({
				model: openai("gpt-4o-mini"),
				system: `Generate a concise, descriptive title (max 6 words) for this conversation. 
					The title should capture the main topic or purpose. 
					Respond with ONLY the title, no quotes or extra text.`,
				messages: [
					{
						role: "user",
						content: `Generate a title for this conversation:\n\n${conversationText}`,
					},
				],
				temperature: 0.3,
				maxTokens: 50,
			});

			// Set headers for streaming response
			c.header("Content-Type", "text/plain; charset=utf-8");
			c.header("Content-Encoding", "none");
			c.header("Transfer-Encoding", "chunked");
			c.header("Connection", "keep-alive");
			c.header("Cache-Control", "no-cache");

			(async (/* iife */) => {
				const title = await result.text;
				thread.meta.title = title;
				thread.meta.updated_at = new Date().toISOString();
				thread.meta.metadata.updated_by = auth_ANONYMOUS_USER_ID;
				threads.set(threadId, thread);
			})();

			return stream(c, (stream) => stream.pipe(result.textStream));
		} else {
			return c.json({ error: "Invalid assistant ID" }, 400);
		}
	} catch (error) {
		console.error("Error generating title:", error);
		return c.json({ error: "Error generating title" }, 500);
	}
});

app.post("/api/chat", async (c) => {
	try {
		const body = await c.req.json();

		// Validate request body
		const parseResult = chatRequestSchema.safeParse(body);
		if (!parseResult.success) {
			console.error("=== VALIDATION ERROR ===");
			console.error("Validation errors:", parseResult.error.errors);
			return c.json(
				{
					error: "Invalid request body",
					details: parseResult.error.errors,
				},
				400
			);
		}

		const request = parseResult.data as ChatRequest;
		const { messages } = request;

		const dataStream = createDataStream({
			execute: async (dataStream) => {
				const result1 = streamText({
					model: openai("gpt-4o-mini"),
					system:
						`Either respond directly to the user or use the tools at your disposal.\n` +
						"If you decide to create an artifact, do not answer and just call the tool or answer with `On it...`.\n",
					messages,
					temperature: 0.7,
					maxTokens: 2000,
					toolChoice: "auto",
					maxSteps: 2,
					tools: {
						weather: tool({
							description: "Get the weather in a location (in Celsius)",
							parameters: z.object({
								location: z
									.string()
									.describe("The location to get the weather for"),
							}),
							execute: async ({ location }) => ({
								location,
								temperature: "200°",
							}),
						}),
						requestCreateArtifact: tool({
							description:
								"Request to create a text artifact that should be displayed in a separate panel.\n" +
								"Use this when the user asks for:\n" +
								"- Creating documents, articles, or stories\n" +
								"- Generating markdown content\n" +
								"- Any substantial text output that would benefit from being editable\n" +
								"- Writing essays, reports, or long-form content\n",
							parameters: z.object({}),
							execute: async () => {
								console.log("🎯 requestCreateArtifact tool called");
								return { requested: true };
							},
						}),
					},
					experimental_transform: smoothStream({
						delayInMs: 100,
					}),
				});

				result1.mergeIntoDataStream(dataStream, {
					experimental_sendFinish: false,
				});

				const response1 = await result1.response;

				const shouldFinish = !response1.messages.some(
					(msg) =>
						msg.role === "assistant" &&
						Array.isArray(msg.content) &&
						msg.content.some(
							(content) =>
								content.type === "tool-call" &&
								content.toolName === "requestCreateArtifact"
						)
				);

				if (shouldFinish) {
					const finishReason = await result1.finishReason;
					const usage = await result1.usage;
					dataStream.write(
						formatDataStreamPart("finish_message", {
							finishReason,
							usage,
						})
					);
				} else {
					const artifactId = randomUUID();

					dataStream.writeData({
						type: "artifact-id",
						id: artifactId,
					});

					const result2 = streamText({
						model: openai("gpt-4o-mini"),
						system: `Generate comprehensive, well-structured content that directly addresses what the user requested. 
							Format the content as markdown when appropriate.`,
						messages: [...messages, ...response1.messages],
						toolChoice: "required",
						temperature: 0.7,
						maxTokens: 2000,
						maxSteps: 1,
						toolCallStreaming: true,
						tools: {
							createArtifact: tool({
								description:
									"Create a text artifact that should be displayed in a separate panel " +
									"Use this when the user asks for: " +
									"- Creating documents, articles, or stories " +
									"- Generating markdown content " +
									"- Any substantial text output that would benefit from being editable " +
									"- Writing essays, reports, or long-form content",
								parameters: createArtifactArgsSchema,
								execute: async (args) => {
									console.log(`✅ Artifact created: ${args.title}`);
									return {
										done: true,
									};
								},
							}),
						},
						experimental_transform: smoothStream({
							delayInMs: 500,
						}),
					});

					result2.mergeIntoDataStream(dataStream, {
						experimental_sendStart: false,
						experimental_sendFinish: false,
					});

					const response2 = await result2.response;

					const result3 = streamText({
						model: openai("gpt-4o-mini"),
						system: `Send a brief confirmation message to the user that the artifact has been created successfully. 
							Keep the message concise and friendly.`,
						messages: [
							...messages,
							...response1.messages,
							...response2.messages,
						],
						temperature: 0.7,
						maxTokens: 200,
						maxSteps: 1,
						toolChoice: "none",
						experimental_transform: smoothStream({
							delayInMs: 100,
						}),
					});

					result3.mergeIntoDataStream(dataStream, {
						experimental_sendStart: false,
					});
				}
			},
			onError: (error) => {
				console.error("/api/chat Data stream error:", error);
				return error instanceof Error ? error.message : String(error);
			},
		});

		c.header("X-Vercel-AI-Data-Stream", "v1");
		c.header("Content-Type", "text/plain; charset=utf-8");
		c.header("Content-Encoding", "none");
		c.header("Transfer-Encoding", "chunked");
		c.header("Connection", "keep-alive");
		c.header("Cache-Control", "no-cache");

		return stream(c, (stream) => stream.pipe(dataStream));
	} catch (error: unknown) {
		console.error("=== API ERROR ===");

		if (isError(error)) {
			console.error("Error message:", error.message);

			if (error.statusCode === 429) {
				return c.json(
					{
						error: "OpenAI API quota exceeded",
						message:
							"You have exceeded your OpenAI API quota. Please check your plan and billing details.",
						details: error.message,
					},
					429
				);
			} else if (error.statusCode === 401) {
				return c.json(
					{
						error: "OpenAI API authentication failed",
						message: "Invalid or missing OpenAI API key.",
						details: error.message,
					},
					401
				);
			} else if (error.statusCode) {
				return c.json(
					{
						error: "OpenAI API error",
						message: error.message,
						statusCode: error.statusCode,
					},
					500
				);
			} else {
				return c.json(
					{
						error: "Internal server error",
						message: error.message,
						type: error.constructor?.name,
					},
					500
				);
			}
		} else {
			console.error("Unknown error type:", typeof error);
			console.error("Error value:", error);

			return c.json(
				{
					error: "Internal server error",
					message: "An unknown error occurred",
					type: typeof error,
				},
				500
			);
		}
	}
});

app.post("/api/assistant-ui-token", async (c) => {
	if (server_auth_get_user_is_authenticated(c)) {
		const body = await c.req.json();

		const user_id = server_auth_get_user_id(c);
		const workspace_id = `${body.orgId}${user_id}`;

		const assistant_ui_cloud = new AssistantCloud({
			apiKey: process.env["VITE_ASSISTANT_UI_API_KEY"]!,
			userId: user_id,
			workspaceId: workspace_id,
		});

		const result = await assistant_ui_cloud.auth.tokens.create();

		return c.json({
			token: result.token,
		});
	} /* Anonymous user */ else {
		const assistant_ui_cloud = new AssistantCloud({
			apiKey: process.env["VITE_ASSISTANT_UI_API_KEY"]!,
			userId: auth_ANONYMOUS_USER_ID,
			workspaceId: auth_ANONYMOUS_WORKSPACE_ID,
		});

		const result = await assistant_ui_cloud.auth.tokens.create();

		return c.json({
			token: result.token,
		});
	}
});

// 404 for all other routes
app.all("*", (c) => {
	return c.json({ error: "Not found" }, 404);
});

// Start server
const port = Number(process.env.PORT) || 3001;

serve({ fetch: app.fetch, port }, () => {
	console.log(`🚀 Hono server is running on port ${port}`);
});

// Generate a message ID that follows the Assistant Cloud pattern, e.g. "msg_00p6RvTKptdp5klszEY0jQEi"
// The cloud uses a "msg_" prefix followed by a 22-24 character alpha-numeric string.
// Using crypto.randomUUID ensures good entropy while keeping the format deterministic.
function generateShortId(): string {
	// Remove dashes from the UUID and take the first 24 characters for consistency with the cloud length
	const randomPart = randomUUID().replace(/-/g, "").substring(0, 24);
	return `msg_${randomPart}`;
}
