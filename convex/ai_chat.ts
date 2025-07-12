import { ai_chat_HARDCODED_PROJECT_ID, ai_chat_HARDCODED_ORG_ID } from "../src/lib/ai_chat.ts";
import { auth_ANONYMOUS_USER_ID } from "../src/lib/auth-constants.ts";
import { math_clamp } from "../src/lib/utils.ts";
import { query, mutation, httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import app_convex_schema from "./schema.ts";
// AI SDK imports
import { openai } from "@ai-sdk/openai";
import { streamText, tool, smoothStream, formatDataStreamPart, type CoreMessage, createDataStreamResponse } from "ai";
import { z } from "zod";
import { createArtifactArgsSchema } from "../src/types/artifact-schemas";
import type { api_schemas_Main } from "../src/lib/api-schemas.ts";

/**
 * Query to list all threads for a workspace with pagination
 */
export const threads_list = query({
	args: {
		paginationOpts: paginationOptsValidator,
		includeArchived: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		args.paginationOpts.numItems = math_clamp(args.paginationOpts.numItems, 1, 50);

		let threadsQuery = ctx.db
			.query("threads")
			.withIndex("by_workspace", (q) => q.eq("workspace_id", ai_chat_HARDCODED_ORG_ID));

		if (args.includeArchived !== true) {
			threadsQuery = threadsQuery.filter((q) => q.eq(q.field("archived"), false));
		}

		const result = await threadsQuery.order("desc").paginate(args.paginationOpts);

		return {
			...result,
			page: {
				threads: result.page,
			},
		};
	},
});

/**
 * Mutation to create a new thread
 */
export const thread_create = mutation({
	args: {
		title: v.optional(v.string()),
		last_message_at: v.number(), // timestamp in milliseconds
		metadata: v.optional(v.any()),
		external_id: v.optional(v.union(v.string())),
		created_by: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { created_by = auth_ANONYMOUS_USER_ID } = args;

		const now = Date.now();

		const thread_id = await ctx.db.insert("threads", {
			title: args.title ?? "New Chat",
			last_message_at: args.last_message_at,
			archived: false,
			workspace_id: ai_chat_HARDCODED_ORG_ID,
			created_by: created_by,
			updated_by: created_by,
			updated_at: now,
			external_id: args.external_id ?? null,
			project_id: ai_chat_HARDCODED_PROJECT_ID,
		});

		return {
			thread_id,
		};
	},
});

/**
 * Mutation to update thread details
 */
export const thread_update = mutation({
	args: {
		thread_id: v.id("threads"),
		title: v.optional(v.string()),
		updated_by: v.optional(v.string()),
		is_archived: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(
			args.thread_id,
			Object.assign(
				{
					updated_by: args.updated_by ?? auth_ANONYMOUS_USER_ID,
					updated_at: Date.now(),
				},
				args.title
					? {
							title: args.title,
						}
					: {},
				args.is_archived
					? {
							archived: args.is_archived,
						}
					: {},
			),
		);
	},
});

/**
 * Mutation to archive/unarchive a thread
 */
export const thread_archive = mutation({
	args: {
		thread_id: v.id("threads"),
		updated_by: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		await ctx.db.patch(args.thread_id, {
			archived: true,
			updated_by: args.updated_by ?? auth_ANONYMOUS_USER_ID,
			updated_at: now,
		});
	},
});

/**
 * Query to list messages in a thread
 */
export const thread_messages_list = query({
	args: {
		thread_id: v.id("threads"),
	},
	handler: async (ctx, args) => {
		const messages = await ctx.db
			.query("messages")
			.withIndex("by_thread", (q) => q.eq("thread_id", args.thread_id))
			.order("desc")
			.collect();

		return { messages };
	},
});

/**
 * Mutation to add a message to a thread
 */
export const thread_messages_add = mutation({
	args: {
		thread_id: v.id("threads"),
		parent_id: v.union(v.id("messages"), v.null()),
		created_by: v.optional(v.string()),
		format: v.string(),
		content: app_convex_schema.tables.messages.validator.fields.content,
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		const created_by = args.created_by ?? auth_ANONYMOUS_USER_ID;

		// Insert the message
		const message_id = await ctx.db.insert("messages", {
			parent_id: args.parent_id,
			thread_id: args.thread_id,
			created_by: created_by,
			updated_by: created_by,
			created_at: now,
			updated_at: now,
			format: args.format,
			height: 1,
			content: args.content,
		});

		// Update the thread's lastMessageAt timestamp
		try {
			await ctx.db.patch(args.thread_id, {
				last_message_at: now,
				updated_at: now,
				updated_by: created_by,
			});
		} catch (error) {
			console.error("Failed to update thread when adding message", error);
		}

		return { message_id };
	},
});

/**
 * HTTP Action for AI chat streaming with tools
 */
export const chat = httpAction(async (ctx, request) => {
	try {
		const body = (await request.json()) as api_schemas_Main["/api/chat"]["get"]["body"];

		// Validate messages from request
		const messages = body.messages as CoreMessage[];
		if (!Array.isArray(messages)) {
			return new Response(JSON.stringify({ error: "Invalid messages format" }), {
				status: 400,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "*",
					"Access-Control-Allow-Headers": "*",
				},
			});
		}

		const response = createDataStreamResponse({
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
								location: z.string().describe("The location to get the weather for"),
							}),
							execute: async ({ location }) => ({
								location,
								temperature: "200°",
							}),
						}),
						request_create_artifact: tool({
							description:
								"Request to create a text artifact that should be displayed in a separate panel.\n" +
								"Use this when the user asks for:\n" +
								"- Creating documents, articles, or stories\n" +
								"- Generating markdown content\n" +
								"- Any substantial text output that would benefit from being editable\n" +
								"- Writing essays, reports, or long-form content\n",
							parameters: z.object({}),
							execute: async () => {
								console.log("🎯 request_create_artifact tool called");
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

				const should_finish = !response1.messages.some(
					(msg) =>
						msg.role === "assistant" &&
						Array.isArray(msg.content) &&
						msg.content.some(
							(content) => content.type === "tool-call" && content.toolName === "request_create_artifact",
						),
				);

				if (should_finish) {
					const finish_reason = await result1.finishReason;
					const usage = await result1.usage;
					dataStream.write(
						formatDataStreamPart("finish_message", {
							finishReason: finish_reason,
							usage,
						}),
					);
				} else {
					// Generate a simple UUID (avoiding external dependencies)
					const artifact_id = crypto.randomUUID();

					dataStream.writeData({
						type: "artifact-id",
						id: artifact_id,
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
							create_artifact: tool({
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
						messages: [...messages, ...response1.messages, ...response2.messages],
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
				console.error("AI chat stream error:", error);
				return error instanceof Error ? error.message : String(error);
			},
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "*",
				"Access-Control-Allow-Headers": "*",
			},
		});

		return response;
	} catch (error: unknown) {
		console.error("AI chat stream error:", error);

		if (error instanceof Error) {
			return new Response(
				JSON.stringify({
					error: "Internal server error",
					message: error.message,
				}),
				{
					status: 500,
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*",
						"Access-Control-Allow-Methods": "*",
						"Access-Control-Allow-Headers": "*",
					},
				},
			);
		}

		return new Response(
			JSON.stringify({
				error: "Internal server error",
				message: "An unknown error occurred",
			}),
			{
				status: 500,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "*",
					"Access-Control-Allow-Headers": "*",
				},
			},
		);
	}
});

/**
 * HTTP Action for generating thread titles
 */
export const thread_generate_title = httpAction(async (ctx, request) => {
	try {
		const body = await request.json();

		if (body.assistant_id !== "system/thread_title") {
			return new Response(JSON.stringify({ error: "Invalid assistant ID" }), {
				status: 400,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "*",
					"Access-Control-Allow-Headers": "*",
				},
			});
		}

		const messages = body.messages || [];
		const thread_id = body.thread_id;

		// Extract conversation text from messages for title generation
		const conversation_text = messages
			.map((msg: any) =>
				[`${msg.role}:`, Array.isArray(msg.content) ? msg.content.map((part: any) => part.text).join(" ") : msg.content]
					.filter(Boolean)
					.join(" "),
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
					content: `Generate a title for this conversation:\n\n${conversation_text}`,
				},
			],
			temperature: 0.3,
			maxTokens: 50,
		});

		// Transform the AI stream to properly encode text chunks
		let title = "";
		const encoder = new TextEncoder();
		const transform_stream = new TransformStream({
			transform(chunk, controller) {
				title += chunk;
				controller.enqueue(encoder.encode(chunk));
			},
			flush: async () => {
				await ctx.runMutation(api.ai_chat.thread_update, {
					thread_id,
					title,
				});
			},
		});

		// Pipe the AI textStream through the transformer
		const stream = result.textStream.pipeThrough(transform_stream);

		// Get the generated title and potentially update thread in database
		// Note: For now, just stream the title back

		return new Response(stream, {
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "*",
				"Access-Control-Allow-Headers": "*",
			},
		});
	} catch (error: unknown) {
		console.error("Title generation error:", error);

		return new Response(
			JSON.stringify({
				error: "Error generating title",
				message: error instanceof Error ? error.message : "Unknown error",
			}),
			{
				status: 500,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "*",
					"Access-Control-Allow-Headers": "*",
				},
			},
		);
	}
});
