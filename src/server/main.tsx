import { openai } from "@ai-sdk/openai";
import { serve } from "@hono/node-server";
import { smoothStream, streamText, tool } from "ai";
import dotenv from "dotenv";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import { z } from "zod";
import { createArtifactArgsSchema } from "../types/artifact-schemas";

// Load environment variables
dotenv.config({ path: ".env.local" });

console.log("OpenAI API Key exists:", !!process.env.OPENAI_API_KEY);
console.log("API Key prefix:", process.env.OPENAI_API_KEY?.substring(0, 10));

// Type guard for errors
function isError(error: unknown): error is Error & {
	statusCode?: number;
	responseBody?: string;
	responseHeaders?: Record<string, unknown>;
	cause?: unknown;
} {
	return error instanceof Error;
}

// Basic validation schema - let AI SDK handle detailed message validation
const chatRequestSchema = z
	.object({
		messages: z.array(z.any()), // Let AI SDK validate the message format
	})
	.passthrough(); // Allow additional fields like tools, etc.

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

		const { messages } = parseResult.data;
		console.log(
			"Messages count:",
			Array.isArray(messages) ? messages.length : 0
		);
		console.log(
			"Last message:",
			Array.isArray(messages) && messages.length > 0
				? messages[messages.length - 1]
				: null
		);

		console.log("Calling OpenAI API...");

		const result = streamText({
			model: openai("gpt-4o-mini"),
			messages: messages as Parameters<typeof streamText>[0]["messages"],
			temperature: 0.7,
			maxTokens: 2000,
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
						temperature: "200°", // Random temp between 5°C and 35°C
					}),
				}),
				createArtifact: tool({
					description:
						"Create a text artifact that should be displayed in a separate pane. " +
						"Use this when the user asks for: " +
						"- Creating documents, articles, or stories " +
						"- Generating markdown content " +
						"- Any substantial text output that would benefit from being editable " +
						"- Writing essays, reports, or long-form content",
					parameters: createArtifactArgsSchema,
					execute: async () => {
						return true;
					},
				}),
			},
			toolCallStreaming: true,
			experimental_transform: smoothStream({
				delayInMs: 100,
			}),
			maxSteps: 5,
		});

		console.log("OpenAI API call successful, returning stream...");

		// Mark the response as a v1 data stream and add streaming headers:
		c.header("X-Vercel-AI-Data-Stream", "v1");
		c.header("Content-Type", "text/plain; charset=utf-8");
		// Headers to fix streaming issues
		c.header("Content-Encoding", "none");
		c.header("Transfer-Encoding", "chunked");
		c.header("Connection", "keep-alive");
		c.header("Cache-Control", "no-cache");

		return stream(c, (stream) => stream.pipe(result.toDataStream()));
	} catch (error: unknown) {
		console.error("=== API ERROR ===");

		if (isError(error)) {
			console.error("Error type:", error.constructor?.name);
			console.error("Error message:", error.message);

			// Log specific OpenAI API errors
			if (error.cause) {
				console.error("Error cause:", error.cause);
			}
			if (error.statusCode) {
				console.error("Status code:", error.statusCode);
			}
			if (error.responseBody) {
				console.error("Response body:", error.responseBody);
			}
			if (error.responseHeaders) {
				console.error("Response headers:", error.responseHeaders);
			}

			// Return appropriate error response based on error type
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
	console.log(`Server is running on port ${port}`);
});
