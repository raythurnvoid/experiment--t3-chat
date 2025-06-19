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
import dotenv from "dotenv";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createArtifactArgsSchema } from "../types/artifact-schemas";
import { randomUUID } from "crypto";
import { stream } from "hono/streaming";

// In-memory thread storage
interface ThreadMeta {
	id: string;
	title: string;
	archived: boolean;
	createdAt: Date;
	updatedAt: Date;
	lastMessageAt: Date;
	workspaceId: string;
	createdBy: string;
	updatedBy: string;
}

// TypeScript interfaces for compile-time type safety
interface ChatRequest {
	messages: CoreMessage[];
	[key: string]: unknown; // Allow additional properties
}

// Real assistant-ui cloud message format (matches the actual cloud API)
interface AssistantMessage {
	id: string;
	parent_id: string | null;
	thread_id: string;
	created_by: string;
	created_at: string;
	updated_by: string;
	updated_at: string;
	format: string;
	content: {
		role: "user" | "assistant" | "system";
		content: MessageContentPart[];
		metadata: AssistantMessageMetadata | UserMessageMetadata;
		status?: {
			type: "complete" | "incomplete" | "running";
			reason: string;
		};
	};
	height: number;
}

interface MessageContentPart {
	type: "text";
	text: string;
	status?: {
		type: "complete" | "incomplete" | "running";
		reason: string;
	};
}

interface AssistantMessageMetadata {
	unstable_state: unknown;
	unstable_annotations: unknown[];
	unstable_data: unknown[];
	steps: MessageStep[];
	custom: Record<string, unknown>;
}

interface UserMessageMetadata {
	custom: Record<string, unknown>;
}

interface MessageStep {
	state: "finished" | "running" | "incomplete";
	messageId?: string;
	finishReason?: string;
	usage?: {
		promptTokens: number;
		completionTokens: number;
	};
	isContinued?: boolean;
}

// Zod schemas for runtime validation (flexible to avoid conflicts with AI SDK)
const chatRequestSchema = z.object({
	messages: z.array(z.any()), // CoreMessage[] - flexible runtime, but TS typed above
	// In Zod v4, additional properties are handled through TypeScript interface above
});

interface ThreadData {
	meta: ThreadMeta;
	messages: AssistantMessage[];
}

// Clear any existing corrupted data and start fresh
const threads = new Map<string, ThreadData>();

// Load environment variables
dotenv.config({ path: ".env.local" });

console.log("OpenAI API Key exists:", !!process.env.OPENAI_API_KEY);

// Type guard for errors
function isError(error: unknown): error is Error & {
	statusCode?: number;
	responseBody?: string;
	responseHeaders?: Record<string, unknown>;
	cause?: unknown;
} {
	return error instanceof Error;
}

// Create Hono app
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

// Basic route
app.get("/", (c) => {
	return c.json({ message: "Hello from Hono server!" });
});

// Health check route
app.get("/api/health", (c) => {
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============= AUTHENTICATION ENDPOINTS FOR ANONYMOUS ACCESS =============

// POST /api/v1/auth/tokens/anonymous - Get anonymous access token
app.post("/api/v1/auth/tokens/anonymous", async (c) => {
	const now = new Date();
	const accessTokenExpiry = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
	const refreshTokenExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

	const accessTokenData = {
		sub: "anonymous",
		iat: Math.floor(now.getTime() / 1000),
		exp: Math.floor(accessTokenExpiry.getTime() / 1000),
	};

	const refreshTokenData = {
		sub: "anonymous",
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

// POST /api/v1/auth/tokens/refresh - Refresh access token
app.post("/api/v1/auth/tokens/refresh", async (c) => {
	try {
		console.log("🔄 Refresh token request received");

		// Log request headers
		const contentType = c.req.header("content-type");
		console.log("📋 Content-Type:", contentType);

		// Parse request body with better error handling
		let body;
		try {
			body = await c.req.json();
			console.log("📄 Request body:", JSON.stringify(body, null, 2));
		} catch (parseError) {
			console.error("❌ Failed to parse request body:", parseError);
			return c.json({ error: "Invalid JSON in request body" }, 400);
		}

		// Handle different possible request formats
		let refreshToken = body.refresh_token || body.refreshToken || body.token;

		// If it's an object with a token property, extract it
		if (typeof refreshToken === "object" && refreshToken?.token) {
			refreshToken = refreshToken.token;
		}

		console.log(
			"🎫 Extracted refresh token:",
			refreshToken ? `${refreshToken.substring(0, 20)}...` : "null"
		);

		if (!refreshToken || typeof refreshToken !== "string") {
			console.warn("⚠️ No valid refresh token provided");
			// Return a new anonymous token instead of error for better UX
			const now = new Date();
			const accessTokenExpiry = new Date(now.getTime() + 60 * 60 * 1000);
			const refreshTokenExpiry = new Date(
				now.getTime() + 7 * 24 * 60 * 60 * 1000
			);

			const accessTokenData = {
				sub: "anonymous",
				iat: Math.floor(now.getTime() / 1000),
				exp: Math.floor(accessTokenExpiry.getTime() / 1000),
			};

			const refreshTokenData = {
				sub: "anonymous",
				iat: Math.floor(now.getTime() / 1000),
				exp: Math.floor(refreshTokenExpiry.getTime() / 1000),
				type: "refresh",
			};

			const accessToken = `anon.${btoa(JSON.stringify(accessTokenData))}`;
			const newRefreshToken = `refresh.${btoa(JSON.stringify(refreshTokenData))}`;

			console.log("✅ Issued new anonymous tokens");
			return c.json({
				access_token: accessToken,
				refresh_token: {
					token: newRefreshToken,
					expires_at: refreshTokenExpiry.toISOString(),
				},
			});
		}

		// Basic validation: check if it starts with our prefix
		if (!refreshToken.startsWith("refresh.")) {
			console.warn("⚠️ Invalid refresh token format, issuing new tokens");
			// Issue new tokens instead of returning error
			const now = new Date();
			const accessTokenExpiry = new Date(now.getTime() + 60 * 60 * 1000);
			const refreshTokenExpiry = new Date(
				now.getTime() + 7 * 24 * 60 * 60 * 1000
			);

			const accessTokenData = {
				sub: "anonymous",
				iat: Math.floor(now.getTime() / 1000),
				exp: Math.floor(accessTokenExpiry.getTime() / 1000),
			};

			const refreshTokenData = {
				sub: "anonymous",
				iat: Math.floor(now.getTime() / 1000),
				exp: Math.floor(refreshTokenExpiry.getTime() / 1000),
				type: "refresh",
			};

			const accessToken = `anon.${btoa(JSON.stringify(accessTokenData))}`;
			const newRefreshToken = `refresh.${btoa(JSON.stringify(refreshTokenData))}`;

			console.log("✅ Issued new anonymous tokens (invalid format recovery)");
			return c.json({
				access_token: accessToken,
				refresh_token: {
					token: newRefreshToken,
					expires_at: refreshTokenExpiry.toISOString(),
				},
			});
		}

		console.log("🔄 Refreshing valid token");
		const now = new Date();
		const accessTokenExpiry = new Date(now.getTime() + 60 * 60 * 1000);
		const refreshTokenExpiry = new Date(
			now.getTime() + 7 * 24 * 60 * 60 * 1000
		);

		const accessTokenData = {
			sub: "anonymous",
			iat: Math.floor(now.getTime() / 1000),
			exp: Math.floor(accessTokenExpiry.getTime() / 1000),
		};

		const refreshTokenData = {
			sub: "anonymous",
			iat: Math.floor(now.getTime() / 1000),
			exp: Math.floor(refreshTokenExpiry.getTime() / 1000),
			type: "refresh",
		};

		const accessToken = `anon.${btoa(JSON.stringify(accessTokenData))}`;
		const newRefreshToken = `refresh.${btoa(JSON.stringify(refreshTokenData))}`;

		console.log("✅ Successfully refreshed tokens");
		return c.json({
			access_token: accessToken,
			refresh_token: {
				token: newRefreshToken,
				expires_at: refreshTokenExpiry.toISOString(),
			},
		});
	} catch (error) {
		console.error("❌ Error refreshing token:", error);
		console.error(
			"❌ Error stack:",
			error instanceof Error ? error.stack : "No stack trace"
		);

		// Return new tokens instead of error to prevent auth failures
		const now = new Date();
		const accessTokenExpiry = new Date(now.getTime() + 60 * 60 * 1000);
		const refreshTokenExpiry = new Date(
			now.getTime() + 7 * 24 * 60 * 60 * 1000
		);

		const accessTokenData = {
			sub: "anonymous",
			iat: Math.floor(now.getTime() / 1000),
			exp: Math.floor(accessTokenExpiry.getTime() / 1000),
		};

		const refreshTokenData = {
			sub: "anonymous",
			iat: Math.floor(now.getTime() / 1000),
			exp: Math.floor(refreshTokenExpiry.getTime() / 1000),
			type: "refresh",
		};

		const accessToken = `anon.${btoa(JSON.stringify(accessTokenData))}`;
		const newRefreshToken = `refresh.${btoa(JSON.stringify(refreshTokenData))}`;

		console.log("✅ Issued fallback tokens after error");
		return c.json({
			access_token: accessToken,
			refresh_token: {
				token: newRefreshToken,
				expires_at: refreshTokenExpiry.toISOString(),
			},
		});
	}
});

// ============= ASSISTANT CLOUD COMPATIBLE API ENDPOINTS =============

// GET /api/v1/threads - List all threads (Real Cloud format)
app.get("/api/v1/threads", (c) => {
	console.log(`📋 Listing threads - total: ${threads.size}`);

	const threadList = Array.from(threads.values()).map((thread) => ({
		id: thread.meta.id,
		workspace_id: thread.meta.workspaceId,
		created_by: thread.meta.createdBy,
		created_at: thread.meta.createdAt.toISOString(),
		updated_by: thread.meta.updatedBy,
		updated_at: thread.meta.updatedAt.toISOString(),
		title: thread.meta.title,
		last_message_at: thread.meta.lastMessageAt.toISOString(),
		is_archived: thread.meta.archived,
		external_id: null,
		metadata: null,
	}));

	console.log(`📤 Returning ${threadList.length} threads`);
	threadList.forEach((thread, idx) => {
		console.log(`  ${idx}: ${thread.id} - "${thread.title}"`);
	});

	return c.json({ threads: threadList });
});

// POST /api/v1/threads - Create new thread (Real Cloud format)
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
			archived: false,
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			workspaceId: "workspace_local_dev",
			createdBy: "anonymous",
			updatedBy: "anonymous",
		},
		messages: [],
	};

	threads.set(threadId, newThread);

	console.log(`✅ Thread created successfully: ${threadId}`);
	console.log(`📊 Total threads now: ${threads.size}`);

	return c.json({ thread_id: threadId });
});

// PUT /api/v1/threads/:threadId - Update thread (Real Cloud format)
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
		thread.meta.archived = body.is_archived;
	}

	thread.meta.updatedAt = new Date();
	thread.meta.updatedBy = "anonymous";

	threads.set(threadId, thread);

	return c.text("", 200);
});

// DELETE /api/v1/threads/:threadId - Delete thread (Real Cloud format)
app.delete("/api/v1/threads/:threadId", (c) => {
	const threadId = c.req.param("threadId");

	if (!threads.has(threadId)) {
		return c.json({ error: "Thread not found" }, 404);
	}

	threads.delete(threadId);

	return c.text("", 200);
});

// GET /api/v1/threads/:threadId/messages - Get thread messages (Real Cloud format)
app.get("/api/v1/threads/:threadId/messages", (c) => {
	const threadId = c.req.param("threadId");
	console.log(`📨 Fetching messages for thread: ${threadId}`);

	const thread = threads.get(threadId);
	if (!thread) {
		console.log(`❌ Thread not found: ${threadId}`);
		return c.json({ error: "Thread not found" }, 404);
	}

	console.log(`📊 Thread has ${thread.messages.length} messages`);

	// Normalize all messages to ensure correct format
	const normalizedMessages = thread.messages.map(normalizeMessageFormat);

	// Update the thread with normalized messages if any were changed
	if (normalizedMessages.some((msg, index) => msg !== thread.messages[index])) {
		console.log(`🔧 Updated thread with normalized message formats`);
		thread.messages = normalizedMessages;
		threads.set(threadId, thread);
	}

	// Sort messages by created_at in reverse chronological order (newest first)
	// This matches the cloud format and is what assistant-ui expects
	const sortedMessages = [...normalizedMessages].sort((a, b) => {
		const timeA = new Date(a.created_at).getTime();
		const timeB = new Date(b.created_at).getTime();
		return timeB - timeA; // Newest first (reverse chronological)
	});

	console.log(
		`📤 Returning ${sortedMessages.length} messages in reverse chronological order`
	);
	sortedMessages.forEach((msg, index) => {
		console.log(
			`  ${index}: ${msg.id} (${msg.content.role}) - ${msg.created_at}`
		);
	});

	// Return in real cloud format (messages in reverse chronological order)
	return c.json({
		messages: sortedMessages,
	});
});

// POST /api/v1/threads/:threadId/messages - Add message to thread (Real Cloud format)
app.post("/api/v1/threads/:threadId/messages", async (c) => {
	const threadId = c.req.param("threadId");
	const body = await c.req.json();

	console.log(`📝 Adding message to thread: ${threadId}`);
	console.log(`📝 Request body:`, JSON.stringify(body, null, 2));

	const thread = threads.get(threadId);
	if (!thread) {
		console.log(`❌ Thread not found: ${threadId}`);
		return c.json({ error: "Thread not found" }, 404);
	}

	const messageId = generateShortId();
	const now = new Date();

	// Ensure content is properly formatted as array of MessageContentPart
	let contentArray: MessageContentPart[];
	console.log(
		"🔍 Processing message content:",
		JSON.stringify(body.content, null, 2)
	);

	if (
		body.content &&
		typeof body.content === "object" &&
		body.content.content &&
		Array.isArray(body.content.content)
	) {
		// Handle nested structure: { content: { role: "user", content: [...] } }
		console.log("  - Using nested content array");
		contentArray = body.content.content;
	} else if (Array.isArray(body.content)) {
		// If content is already an array, use it directly
		console.log("  - Using direct content array");
		contentArray = body.content;
	} else if (typeof body.content === "string") {
		// If content is a string, wrap it in the proper format
		console.log("  - Converting string content to array");
		contentArray = [{ type: "text", text: body.content }];
	} else if (body.text) {
		// Fallback to text field
		console.log("  - Using fallback text field");
		contentArray = [{ type: "text", text: body.text }];
	} else {
		// Default empty content
		console.log("  - Using default empty content");
		contentArray = [{ type: "text", text: "" }];
	}

	console.log("🔍 Final content array:", JSON.stringify(contentArray, null, 2));

	// Create message in exact cloud format
	const assistantMessage: AssistantMessage = {
		id: messageId,
		parent_id: body.parent_id || null,
		thread_id: threadId,
		created_by: "anonymous",
		created_at: now.toISOString(),
		updated_by: "anonymous",
		updated_at: now.toISOString(),
		format: "aui/v0",
		content: {
			role: (body.content && body.content.role) || body.role || "user",
			content: contentArray,
			metadata:
				((body.content && body.content.role) || body.role) === "assistant"
					? ({
							unstable_state: null,
							unstable_annotations: [],
							unstable_data: [],
							steps: [],
							custom: {},
						} as AssistantMessageMetadata)
					: ({
							custom: {},
						} as UserMessageMetadata),
		},
		height:
			((body.content && body.content.role) || body.role) === "user" ? 0 : 1,
	};

	thread.messages.push(assistantMessage);
	thread.meta.lastMessageAt = now;
	thread.meta.updatedAt = now;
	threads.set(threadId, thread);

	console.log(`✅ Message added successfully: ${messageId}`);
	console.log(`📊 Thread now has ${thread.messages.length} messages`);
	console.log(`💾 Stored message:`, JSON.stringify(assistantMessage, null, 2));

	return c.json({ message_id: messageId });
});

// POST /api/v1/runs/stream - Title generation (Real Cloud format)
app.post("/api/v1/runs/stream", async (c) => {
	try {
		const body = await c.req.json();
		console.log("🏷️ Generating title for thread:", body.thread_id);

		// Extract the conversation context
		const messages = body.messages || [];
		let conversationText = "";

		// Get the first few messages to understand the conversation
		for (const msg of messages.slice(0, 3)) {
			if (msg.content && Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "text" && part.text) {
						conversationText += part.text + " ";
					}
				}
			}
		}

		// Simple title generation based on content
		let generatedTitle = "New Chat";
		if (conversationText.trim()) {
			const words = conversationText.trim().split(/\s+/).slice(0, 4);
			generatedTitle = words.join(" ");
			if (generatedTitle.length > 50) {
				generatedTitle = generatedTitle.substring(0, 47) + "...";
			}
		}

		console.log(`📝 Generated title: "${generatedTitle}"`);

		// Update the thread title
		const thread = threads.get(body.thread_id);
		if (thread) {
			thread.meta.title = generatedTitle;
			thread.meta.updatedAt = new Date();
			threads.set(body.thread_id, thread);
		}

		// Return the title as plain text (like the real API)
		c.header("Content-Type", "text/plain; charset=utf-8");
		c.header("X-Vercel-AI-Data-Stream", "v1");
		return c.text(generatedTitle);
	} catch (error) {
		console.error("Error generating title:", error);
		c.header("Content-Type", "text/plain; charset=utf-8");
		return c.text("New Chat");
	}
});

// Chat API route
app.post("/api/chat", async (c) => {
	try {
		console.log("=== NEW CHAT REQUEST ===");

		const body = await c.req.json();
		console.log("Request received with body keys:", Object.keys(body));

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
		console.log(
			"Messages count:",
			Array.isArray(messages) ? messages.length : 0
		);

		// Find or create thread for this conversation
		let targetThread: ThreadData | null = null;

		const threadId = body.state?.threadId as string | undefined;
		if (threadId && threads.has(threadId)) {
			targetThread = threads.get(threadId)!;
			console.log(`📂 Using existing thread: ${threadId}`);
		} else {
			// Create new thread
			const newThreadId = `thread_${randomUUID().replace(/-/g, "").substring(0, 24)}`;
			const now = new Date();
			targetThread = {
				meta: {
					id: newThreadId,
					title: "New Chat",
					archived: false,
					createdAt: now,
					updatedAt: now,
					lastMessageAt: now,
					workspaceId: "workspace_local_dev",
					createdBy: "anonymous",
					updatedBy: "anonymous",
				},
				messages: [],
			};
			threads.set(newThreadId, targetThread);
			console.log(`🆕 Created new thread: ${newThreadId}`);
		}

		console.log("Creating multi-step data stream response...");

		const dataStream = createDataStream({
			execute: async (dataStream) => {
				console.log(
					"=== STEP 1: Initial response with requestCreateArtifact tool ==="
				);

				const result1 = streamText({
					model: openai("gpt-4o-mini"),
					system:
						`Either respond directly to the user or use the tools at your disposal and then answer.\n` +
						"If you decide to create an artifact, inform the user that you will do it and then request the creation of the artifact",
					messages: messages as CoreMessage[],
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
								"Request to create a text artifact that should be displayed in a separate pane. " +
								"Use this when the user asks for: " +
								"- Creating documents, articles, or stories " +
								"- Generating markdown content " +
								"- Any substantial text output that would benefit from being editable " +
								"- Writing essays, reports, or long-form content",
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

				console.log("=== Waiting for step 1 to complete ===");

				const response1 = await result1.response;
				console.log("Step 1 completed, checking tool calls...");

				// Store user message in thread
				const userMessage = messages[messages.length - 1];
				if (userMessage && userMessage.role === "user") {
					const userMessageId = generateShortId();
					const now = new Date();
					const userAssistantMessage: AssistantMessage = {
						id: userMessageId,
						parent_id: null,
						thread_id: targetThread.meta.id,
						created_by: "anonymous",
						created_at: now.toISOString(),
						updated_by: "anonymous",
						updated_at: now.toISOString(),
						format: "aui/v0",
						content: {
							role: "user",
							content: coreMessageToAssistantContent(userMessage),
							metadata: {
								custom: {},
							} as UserMessageMetadata,
						},
						height: 0,
					};
					targetThread.messages.push(userAssistantMessage);
					targetThread.meta.lastMessageAt = new Date();
					threads.set(targetThread.meta.id, targetThread);
					console.log(
						`💾 Stored user message in thread: ${targetThread.meta.id}`
					);
				}

				const hasRequestCreateArtifact = response1.messages.some(
					(msg) =>
						msg.role === "assistant" &&
						Array.isArray(msg.content) &&
						msg.content.some(
							(content) =>
								content.type === "tool-call" &&
								content.toolName === "requestCreateArtifact"
						)
				);

				if (hasRequestCreateArtifact) {
					console.log("=== STEP 2: Creating artifact content ===");

					const artifactId = randomUUID();
					console.log(`🆔 Generated artifact UUID: ${artifactId}`);

					dataStream.writeData({
						type: "artifact-id",
						id: artifactId,
					});

					const result2 = streamText({
						model: openai("gpt-4o-mini"),
						system: `Generate comprehensive, well-structured content that directly addresses what the user requested. 
							Format the content as markdown when appropriate.`,
						messages: [...messages, ...response1.messages] as CoreMessage[],
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

					console.log("=== Waiting for step 2 to complete ===");

					const response2 = await result2.response;
					console.log("Step 2 completed, proceeding to confirmation step...");

					const result3 = streamText({
						model: openai("gpt-4o-mini"),
						system: `Send a brief confirmation message to the user that the artifact has been created successfully. 
							Keep the message concise and friendly.`,
						messages: [
							...messages,
							...response1.messages,
							...response2.messages,
						] as CoreMessage[],
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

					// Wait for final response
					const response3 = await result3.response;

					// Store assistant response with proper format after all steps complete
					const assistantMessageId = generateShortId();
					const finalAssistantText = extractTextFromResponse([
						...response1.messages,
						...response2.messages,
						...response3.messages,
					]);

					const now = new Date();
					const assistantMessage: AssistantMessage = {
						id: assistantMessageId,
						parent_id:
							targetThread.messages.length > 0
								? targetThread.messages[targetThread.messages.length - 1].id
								: null,
						thread_id: targetThread.meta.id,
						created_by: "anonymous",
						created_at: now.toISOString(),
						updated_by: "anonymous",
						updated_at: now.toISOString(),
						format: "aui/v0",
						content: {
							role: "assistant",
							content: [
								{
									type: "text",
									text: finalAssistantText || "Artifact created successfully",
									status: {
										type: "complete",
										reason: "stop",
									},
								},
							],
							metadata: {
								unstable_state: null,
								unstable_annotations: [],
								unstable_data: [],
								steps: [
									{
										state: "finished",
										messageId: `msg-${randomUUID()}`,
										finishReason: "stop",
										usage: { promptTokens: 165, completionTokens: 10 },
										isContinued: false,
									},
								],
								custom: {},
							} as AssistantMessageMetadata,
							status: {
								type: "complete",
								reason: "stop",
							},
						},
						height: 1,
					};

					targetThread.messages.push(assistantMessage);
					targetThread.meta.lastMessageAt = new Date();
					threads.set(targetThread.meta.id, targetThread);
					console.log(
						`💾 Stored assistant response in thread: ${targetThread.meta.id}`
					);
				} else {
					console.log("=== No artifact requested, sending finish event ===");

					// Wait for response1 to complete
					const finalText = extractTextFromResponse(response1.messages);

					// Store assistant response for non-artifact messages with proper format
					const assistantMessageId = generateShortId();
					const now = new Date();
					const assistantMessage: AssistantMessage = {
						id: assistantMessageId,
						parent_id:
							targetThread.messages.length > 0
								? targetThread.messages[targetThread.messages.length - 1].id
								: null,
						thread_id: targetThread.meta.id,
						created_by: "anonymous",
						created_at: now.toISOString(),
						updated_by: "anonymous",
						updated_at: now.toISOString(),
						format: "aui/v0",
						content: {
							role: "assistant",
							content: [
								{
									type: "text",
									text: finalText || "Hello! How can I assist you today?",
									status: {
										type: "complete",
										reason: "stop",
									},
								},
							],
							metadata: {
								unstable_state: null,
								unstable_annotations: [],
								unstable_data: [],
								steps: [
									{
										state: "finished",
										messageId: `msg-${randomUUID()}`,
										finishReason: "stop",
										usage: { promptTokens: 165, completionTokens: 10 },
										isContinued: false,
									},
								],
								custom: {},
							} as AssistantMessageMetadata,
							status: {
								type: "complete",
								reason: "stop",
							},
						},
						height: 1,
					};

					targetThread.messages.push(assistantMessage);
					targetThread.meta.lastMessageAt = new Date();
					threads.set(targetThread.meta.id, targetThread);

					dataStream.write(
						formatDataStreamPart("finish_message", {
							finishReason: "stop",
							usage: {
								promptTokens: 0,
								completionTokens: 0,
							},
						})
					);
				}
			},
			onError: (error) => {
				console.error("=== DATA STREAM ERROR ===", error);
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

// Catch-all for API routes
app.all("/api/*", (c) => {
	return c.json({ error: "API endpoint not found" }, 404);
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

// Helper function to convert AI SDK CoreMessage to assistant content format
function coreMessageToAssistantContent(
	coreMessage: CoreMessage
): MessageContentPart[] {
	const contentParts: MessageContentPart[] = [];

	console.log("🔍 Converting CoreMessage to AssistantContent:");
	console.log("  - Role:", coreMessage.role);
	console.log("  - Content type:", typeof coreMessage.content);
	console.log("  - Content value:", JSON.stringify(coreMessage.content));

	if (typeof coreMessage.content === "string") {
		console.log("  - Processing string content:", coreMessage.content);
		contentParts.push({
			type: "text",
			text: coreMessage.content,
		});
	} else if (Array.isArray(coreMessage.content)) {
		console.log(
			"  - Processing array content with",
			coreMessage.content.length,
			"parts"
		);
		for (const part of coreMessage.content) {
			console.log("    - Part type:", part.type);
			if (part.type === "text" && "text" in part) {
				console.log("    - Text content:", part.text);
				contentParts.push({
					type: "text",
					text: part.text || "",
				});
			} else {
				console.log("    - Non-text part, skipping");
			}
			// Add other content types as needed
		}
	} else {
		console.log("  - Unknown content format, defaulting to empty string");
		contentParts.push({
			type: "text",
			text: "",
		});
	}

	console.log(
		"  - Final content parts:",
		JSON.stringify(contentParts, null, 2)
	);
	return contentParts;
}

// Helper function to extract text from AI SDK response messages
function extractTextFromResponse(messages: CoreMessage[]): string {
	let extractedText = "";

	for (const message of messages) {
		if (message.role === "assistant" && message.content) {
			if (typeof message.content === "string") {
				extractedText += message.content + " ";
			} else if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part.type === "text" && part.text) {
						extractedText += part.text + " ";
					}
				}
			}
		}
	}

	return extractedText.trim();
}

// Helper function to ensure message format matches cloud format exactly
function normalizeMessageFormat(message: AssistantMessage): AssistantMessage {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const messageAny = message as any;

	// If the message already has the correct format, return it
	if (
		messageAny.content &&
		typeof messageAny.content.role === "string" &&
		Array.isArray(messageAny.content.content) &&
		messageAny.content.metadata
	) {
		return message;
	}

	// If the content has double nesting (old format), fix it
	if (
		messageAny.content &&
		messageAny.content.content &&
		messageAny.content.content.role &&
		messageAny.content.content.content &&
		messageAny.content.content.metadata
	) {
		console.log(
			`🔧 Fixing double-nested message format for message ${messageAny.id}`
		);

		// Extract the inner content structure
		const innerContent = messageAny.content.content;

		return {
			...messageAny,
			content: {
				role: innerContent.role,
				content: Array.isArray(innerContent.content)
					? innerContent.content
					: [{ type: "text", text: innerContent.content || "" }],
				metadata: innerContent.metadata,
				status: innerContent.status,
			},
		} as AssistantMessage;
	}

	console.log(
		`⚠️ Unknown message format for message ${messageAny.id}, keeping as-is`
	);
	return message;
}
