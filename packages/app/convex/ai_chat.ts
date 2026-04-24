import { composite_id, omit_properties, should_never_happen } from "../shared/shared-utils.ts";
import { ai_chat_MODEL_IDS, ai_chat_MODE_IDS, type ai_chat_AiSdk5UiMessage } from "../shared/ai-chat.ts";
import { get_id_generator, math_clamp } from "../src/lib/utils.ts";
import { query, mutation, httpAction, type ActionCtx } from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";
import { paginationOptsValidator, paginationResultValidator, type RouteSpec } from "convex/server";
import { doc } from "convex-helpers/validators";
import { v } from "convex/values";
import { openai } from "@ai-sdk/openai";
import {
	streamText,
	smoothStream,
	createUIMessageStream,
	createUIMessageStreamResponse,
	consumeStream,
	stepCountIs,
	convertToModelMessages,
	validateUIMessages,
	TypeValidationError,
} from "ai";
import { z } from "zod";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import {
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { workspaces_db_get_membership_for_user } from "../server/workspaces.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import type { app_convex_Doc, app_convex_Id } from "../src/lib/app-convex-client.ts";
import {
	ai_chat_tool_create_list_pages,
	ai_chat_tool_create_read_page,
	ai_chat_tool_create_glob_pages,
	ai_chat_tool_create_grep_pages,
	ai_chat_tool_create_text_search_pages,
	ai_chat_tool_create_write_page,
	ai_chat_tool_create_edit_page,
	ai_chat_tool_create_web_search,
	ai_chat_WRITE_TOOL_NAMES,
} from "../server/server-ai-tools.ts";
import app_convex_schema from "./schema.ts";
import type { RouterForConvexModules } from "./http.ts";
import { Result } from "../src/lib/errors-as-values-utils.ts";
import { billing_event } from "../server/billing.ts";
import { billing_ingest_events } from "./billing.ts";

export {
	remove_pages_pending_edit_if_expired,
	upsert_pages_pending_edit_updates,
	persist_pages_pending_edit_rebased_state,
	get_pages_pending_edit,
	get_pages_pending_edit_last_sequence_saved,
	list_pages_pending_edits,
	save_pages_pending_edit,
} from "./pages_pending_edits.ts";

const ai_chat_TITLE_MODEL_ID = "gpt-4.1-nano" as const;

const ai_chat_TITLE_SYSTEM_PROMPT = [
	"Generate a concise, descriptive title (max 6 words) for this conversation.",
	"The title should capture the main topic or purpose.",
	"Respond with ONLY the title, no quotes or extra text.",
].join("\n");

const ai_chat_SYSTEM_PROMPT = [
	"You are the app chat agent for the user's workspace.",
	"Respond directly when you can answer confidently without tools.",
	"When the request depends on existing page content or paths, read or search before you write or edit.",
	"`write_page` and `edit_page` create pending review changes for the user; they do not silently publish live content.",
	"If a read, search, or path lookup is uncertain, say so and use the tools to clarify instead of inventing content or paths.",
	"Use `web_search` for current public facts, official documentation, release notes, news, and other information outside this workspace when page tools are not enough.",
	"Summarize `web_search` highlight snippets in your own words; do not paste large raw tool outputs.",
	"If `web_search` fails, say you could not retrieve current web results and continue from workspace context only; do not ask the user to configure keys or environment variables.",
	"After tool results, give the user a concise direct answer and only continue using tools when it materially helps.",
].join("\n");

const ai_chat_ASK_MODE_SYSTEM_PROMPT_SUFFIX =
	"You are in Ask mode: do not call `write_page` or `edit_page`. Answer from reads and searches only.";

function compute_token_usage_cost_cents(args: { modelId: string; inputTokens: number; outputTokens: number }) {
	switch (args.modelId) {
		case "gpt-5.4-nano":
		case "gpt-4.1-nano":
			return args.inputTokens * 0.00001 + args.outputTokens * 0.00004;
		case "gpt-5.4-mini":
		default:
			return args.inputTokens * 0.00003 + args.outputTokens * 0.00015;
	}
}

function ai_chat_get_agent_configuration(input: {
	ctx: ActionCtx;
	ctxData: {
		workspaceId: string;
		projectId: string;
		userId: app_convex_Id<"users">;
	};
	args: {
		modeId: (typeof ai_chat_MODE_IDS)[number];
	};
}) {
	const {
		ctx,
		ctxData,
		args: { modeId },
	} = input;

	const tools = {
		read_page: ai_chat_tool_create_read_page(ctx, ctxData),
		list_pages: ai_chat_tool_create_list_pages(ctx, ctxData),
		glob_pages: ai_chat_tool_create_glob_pages(ctx, ctxData),
		grep_pages: ai_chat_tool_create_grep_pages(ctx, ctxData),
		text_search_pages: ai_chat_tool_create_text_search_pages(ctx, ctxData),
		write_page: ai_chat_tool_create_write_page(ctx, ctxData),
		edit_page: ai_chat_tool_create_edit_page(ctx, ctxData),
		web_search: ai_chat_tool_create_web_search(),
	};

	const writeToolNames = new Set<string>(ai_chat_WRITE_TOOL_NAMES);

	// Keep the full tool registry for validation. Ask mode only narrows the tool
	// names exposed to generation so historical write-tool messages still validate.
	const activeTools = (Object.keys(tools) as Array<keyof typeof tools>).filter((name) => {
		return modeId === "ask" ? !writeToolNames.has(name) : true;
	});

	return {
		systemPrompt:
			modeId === "ask" ? `${ai_chat_SYSTEM_PROMPT}\n${ai_chat_ASK_MODE_SYSTEM_PROMPT_SUFFIX}` : ai_chat_SYSTEM_PROMPT,
		tools,
		activeTools,
	};
}

export const threads_list = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		paginationOpts: paginationOptsValidator,
		archived: v.optional(v.boolean()),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "ai_chat_threads")),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: user.id,
			membershipId: args.membershipId,
		});

		if (!membership) {
			return {
				page: [],
				isDone: true,
				continueCursor: "",
			};
		}

		const numItems = math_clamp(args.paginationOpts.numItems ?? 100, 1, 100);
		const archived = args.archived ?? false;

		const threads_query = ctx.db
			.query("ai_chat_threads")
			.withIndex("byWorkspaceProjectArchivedLastMessageAt", (q) =>
				q.eq("workspaceId", membership.workspaceId).eq("projectId", membership.projectId).eq("archived", archived),
			);

		const result = await threads_query.order("desc").paginate({
			...args.paginationOpts,
			numItems,
		});

		return result;
	},
});

/**
 * Query to get a single thread by ID
 */
export const thread_get = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		/**
		 * Can be a temporary ID generated by Assistant UI
		 **/
		threadId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "ai_chat_threads"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: user.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const id_normalized = ctx.db.normalizeId("ai_chat_threads", args.threadId);

		if (!id_normalized) {
			return null;
		}

		const thread = await ctx.db.get("ai_chat_threads", id_normalized);

		if (!thread || thread.workspaceId !== membership.workspaceId || thread.projectId !== membership.projectId) {
			return null;
		}

		return thread;
	},
});

/**
 * Mutation to create a new thread
 */
export const thread_create = mutation({
	args: v.object({
		membershipId: v.id("workspaces_projects_users"),
		clientGeneratedId: app_convex_schema.tables.ai_chat_threads.validator.fields.clientGeneratedId,
		title: v.optional(app_convex_schema.tables.ai_chat_threads.validator.fields.title),
		lastMessageAt: app_convex_schema.tables.ai_chat_threads.validator.fields.lastMessageAt,
	}),
	returns: v_result({
		_yay: v.object({
			threadId: v.id("ai_chat_threads"),
		}),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: user.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const now = Date.now();

		const threadId = await ctx.db.insert("ai_chat_threads", {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			clientGeneratedId: args.clientGeneratedId,
			title: args.title ?? null,
			lastMessageAt: args.lastMessageAt,
			archived: false,
			runtime: "aisdk_5",
			createdBy: user.id,
			updatedBy: user.id,
			updatedAt: now,
			starred: false,
		});

		return Result({ _yay: { threadId } });
	},
});

/**
 * Branch a thread by creating a new thread with the same source thread as parent.
 *
 * @param args.membershipId
 * @param args.threadId
 * @param args.messageId - The ID of the message to start the new thread from. Must be a convex generated ID of a persisted message.
 */
export const thread_branch = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		threadId: v.string(),
		messageId: v.optional(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			threadId: v.id("ai_chat_threads"),
		}),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: user.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		if (!threadId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const thread = await ctx.db.get("ai_chat_threads", threadId);
		if (!thread) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (thread.workspaceId !== membership.workspaceId || thread.projectId !== membership.projectId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const now = Date.now();
		const workspaceId = thread.workspaceId;
		const projectId = thread.projectId;

		const allMessages = await ctx.db
			.query("ai_chat_threads_messages_aisdk_5")
			.withIndex("byWorkspaceProjectThread", (q) =>
				q.eq("workspaceId", thread.workspaceId).eq("projectId", thread.projectId).eq("threadId", threadId),
			)
			.collect();

		const byId = new Map<string, app_convex_Doc<"ai_chat_threads_messages_aisdk_5">>(
			allMessages.map((m) => [m._id, m]),
		);

		let newestMessage = undefined;
		if (args.messageId) {
			const messageId = ctx.db.normalizeId("ai_chat_threads_messages_aisdk_5", args.messageId);
			const message = messageId ? byId.get(messageId) : undefined;
			if (!message) {
				return Result({ _nay: { message: "Message not found" } });
			}
			newestMessage = message;
		}

		const unarchivedThreads = await ctx.db
			.query("ai_chat_threads")
			.withIndex("byWorkspaceProjectArchivedLastMessageAt", (q) =>
				q.eq("workspaceId", workspaceId).eq("projectId", projectId).eq("archived", false),
			)
			.collect();

		const archivedThreads = await ctx.db
			.query("ai_chat_threads")
			.withIndex("byWorkspaceProjectArchivedLastMessageAt", (q) =>
				q.eq("workspaceId", workspaceId).eq("projectId", projectId).eq("archived", true),
			)
			.collect();

		const sourceTitle = (thread.title || "New Chat").trim() || "New Chat";
		const baseTitle = sourceTitle.replace(/ \(\d+\)$/, "");

		let maxSuffix = 0;
		for (const thread of [...unarchivedThreads, ...archivedThreads]) {
			const title = (thread.title || "New Chat").trim() || "New Chat";
			const normalized = title.replace(/ \(\d+\)$/, "");
			if (normalized !== baseTitle) {
				continue;
			}

			const match = title.match(/ \((\d+)\)$/);
			if (!match) {
				continue;
			}

			const n = Number(match[1]);
			if (Number.isFinite(n) && n > maxSuffix) {
				maxSuffix = n;
			}
		}

		if (!newestMessage) {
			let newest: app_convex_Doc<"ai_chat_threads_messages_aisdk_5"> | null = null;

			for (const message of allMessages) {
				if (!newest || message._creationTime > newest._creationTime) {
					newest = message;
				}
			}

			newestMessage = newest;
		}

		const title = `${baseTitle} (${maxSuffix + 1})`;
		const clientGeneratedId = get_id_generator("ai_thread")();

		const newThreadId = await ctx.db.insert("ai_chat_threads", {
			workspaceId,
			projectId,
			clientGeneratedId,
			title,
			lastMessageAt: now,
			archived: false,
			runtime: "aisdk_5",
			createdBy: user.id,
			updatedBy: user.id,
			updatedAt: now,
			starred: false,
		});

		if (!newestMessage) {
			return Result({ _yay: { threadId: newThreadId } });
		}

		const chain: Array<app_convex_Doc<"ai_chat_threads_messages_aisdk_5">> = [];

		let current: app_convex_Doc<"ai_chat_threads_messages_aisdk_5"> | undefined = newestMessage;
		while (current) {
			chain.push(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}

		const messages: Array<{
			clientGeneratedMessageId: string;
			content: Record<string, unknown>;
		}> = [];

		for (let i = chain.length - 1; i >= 0; i--) {
			const msg = chain[i];
			const content = msg.content as unknown as ai_chat_AiSdk5UiMessage;
			const nextId = get_id_generator("ai_message")();
			const metadata = content.metadata
				? omit_properties(content.metadata, ["convexParentId", "convexId", "parentClientGeneratedId"])
				: undefined;

			messages.push({
				clientGeneratedMessageId: nextId,
				content: {
					...content,
					id: nextId,
					...(metadata ? { metadata } : {}),
				},
			});
		}

		let nextParentId: app_convex_Id<"ai_chat_threads_messages_aisdk_5"> | null = null;
		for (const message of messages) {
			const insertedId: app_convex_Id<"ai_chat_threads_messages_aisdk_5"> = await ctx.db.insert(
				"ai_chat_threads_messages_aisdk_5",
				{
					workspaceId,
					projectId,
					parentId: nextParentId,
					threadId: newThreadId,
					createdBy: user.id,
					updatedAt: now,
					clientGeneratedMessageId: message.clientGeneratedMessageId,
					content: message.content,
				},
			);

			nextParentId = insertedId;
		}

		await ctx.db.patch("ai_chat_threads", newThreadId, {
			lastMessageAt: now,
			updatedAt: now,
			updatedBy: user.id,
		});

		return Result({ _yay: { threadId: newThreadId } });
	},
});

/**
 * Mutation to update thread details
 */
export const thread_update = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		threadId: v.string(),
		title: v.optional(v.union(v.string(), v.null())),
		isArchived: v.optional(v.boolean()),
		starred: v.optional(v.boolean()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: user.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		if (!threadId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const thread = await ctx.db.get("ai_chat_threads", threadId);
		if (!thread) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (thread.workspaceId !== membership.workspaceId || thread.projectId !== membership.projectId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		await ctx.db.patch(
			"ai_chat_threads",
			threadId,
			Object.assign(
				{
					updatedBy: user.id,
					updatedAt: Date.now(),
				},
				args.title !== undefined
					? {
							title: args.title,
						}
					: {},
				args.isArchived !== undefined
					? {
							archived: args.isArchived,
						}
					: {},
				args.starred !== undefined
					? {
							starred: args.starred,
						}
					: {},
			),
		);

		return Result({ _yay: null });
	},
});

/**
 * Mutation to archive/unarchive a thread
 */
export const thread_archive = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		threadId: v.id("ai_chat_threads"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: user.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (!thread) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (thread.workspaceId !== membership.workspaceId || thread.projectId !== membership.projectId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const now = Date.now();

		await ctx.db.patch("ai_chat_threads", args.threadId, {
			archived: true,
			updatedBy: user.id,
			updatedAt: now,
		});

		return Result({ _yay: null });
	},
});

/**
 * Query to list messages in a thread
 */
export const thread_messages_list = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		threadId: v.string(),
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
	},
	returns: v.union(
		v.object({
			messages: v.array(doc(app_convex_schema, "ai_chat_threads_messages_aisdk_5")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: user.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		if (!threadId) {
			return null;
		}

		const thread = await ctx.db.get("ai_chat_threads", threadId);
		if (!thread || thread.workspaceId !== membership.workspaceId || thread.projectId !== membership.projectId) {
			return null;
		}

		const messages = await ctx.db
			.query("ai_chat_threads_messages_aisdk_5")
			.withIndex("byWorkspaceProjectThread", (q) =>
				q.eq("workspaceId", thread.workspaceId).eq("projectId", thread.projectId).eq("threadId", threadId),
			)
			.order(args.order ?? "desc")
			.collect();

		return { messages };
	},
});

/**
 * Mutation to add one or more messages to a thread.
 *
 * It won't check for duplicates.
 */
export const thread_messages_add = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		threadId: v.id("ai_chat_threads"),
		parentId: v.optional(v.union(v.string(), v.null())),
		messages: v.array(
			v.object({
				clientGeneratedMessageId:
					app_convex_schema.tables.ai_chat_threads_messages_aisdk_5.validator.fields.clientGeneratedMessageId,
				content: app_convex_schema.tables.ai_chat_threads_messages_aisdk_5.validator.fields.content,
			}),
		),
	},
	returns: v_result({
		_yay: v.object({
			ids: v.array(v.id("ai_chat_threads_messages_aisdk_5")),
		}),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: user.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (!thread) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (thread.workspaceId !== membership.workspaceId || thread.projectId !== membership.projectId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const parentId = args.parentId ? ctx.db.normalizeId("ai_chat_threads_messages_aisdk_5", args.parentId) : null;

		const now = Date.now();

		const ids: Array<app_convex_Id<"ai_chat_threads_messages_aisdk_5">> = [];
		let nextParentId = parentId;
		for (const message of args.messages) {
			const messageId = await ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
				workspaceId: thread.workspaceId,
				projectId: thread.projectId,
				parentId: nextParentId,
				threadId: args.threadId,
				createdBy: user.id,
				updatedAt: now,
				clientGeneratedMessageId: message.clientGeneratedMessageId,
				content: message.content,
			});

			ids.push(messageId);
			nextParentId = messageId;
		}

		if (ids.length > 0) {
			await ctx.db.patch("ai_chat_threads", args.threadId, {
				lastMessageAt: now,
				updatedAt: now,
				updatedBy: user.id,
			});
		}

		return Result({ _yay: { ids } });
	},
});

export function ai_chat_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/api/chat" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						/**
						 * See {@link PrepareSendMessagesRequest}.
						 *
						 * See {@link AssistantChatTransport.prepareSendMessagesRequest}.
						 **/
						const bodyValidator = z.object({
							/**
							 * The messages to append to the thread.
							 */
							messages: z.array(z.any()),
							/**
							 * Server-allowlisted model.
							 */
							model: z.enum(ai_chat_MODEL_IDS),
							/** Agent mode */
							mode: z.enum(ai_chat_MODE_IDS),
							trigger: z.enum(["submit-message", "regenerate-message"]),
							/**
							 * The id of the message to which the new message should be appended.
							 * `null` means root.
							 */
							parentId: z.string().nullable().optional(),
							/**
							 * The id of the thread to which the new message should be appended.
							 *
							 * `undefined` for new threads.
							 */
							threadId: z.string().optional(),

							/**
							 * The client generated id for a new thread.
							 */
							clientGeneratedThreadId: z.string().optional(),

							/**
							 * Authenticated membership scope.
							 *
							 * Server derives workspace/project from this row.
							 **/
							membershipId: z.string(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							try {
								const requestParseResult = await server_request_json_parse_and_validate(request, bodyValidator);

								if (requestParseResult._nay) {
									return {
										status: 400,
										body: requestParseResult._nay,
									} as const;
								}

								const body = requestParseResult._yay;

								const membership = await ctx.runQuery(api.workspaces.get_membership_from_string, {
									membershipId: body.membershipId,
								});

								if (!membership) {
									return {
										status: 403,
										body: {
											message: "Unauthorized",
										},
									} as const;
								}

								if (body.threadId == null && body.clientGeneratedThreadId == null) {
									return {
										status: 400,
										body: {
											message: "One of `threadId` or `clientGeneratedThreadId` is required",
										},
									} as const;
								}

								const { systemPrompt, tools, activeTools } = ai_chat_get_agent_configuration({
									ctx,
									ctxData: {
										workspaceId: membership.workspaceId,
										projectId: membership.projectId,
										userId: membership.userId,
									},
									args: {
										modeId: body.mode,
									},
								});

								// Validate the messages if they are present
								if (body.messages.length > 0) {
									try {
										await validateUIMessages<ai_chat_AiSdk5UiMessage>({
											messages: body.messages,
											tools: tools,
										});
									} catch (error) {
										if (error instanceof TypeValidationError) {
											return {
												status: 400,
												body: {
													message: "Invalid messages format",
													cause:
														error == null
															? undefined
															: { message: error instanceof Error ? error.message : String(error) },
												},
											} as const;
										} else {
											const msg = "Failed to validate chat messages";
											should_never_happen(msg, {
												cause:
													error == null
														? undefined
														: { message: error instanceof Error ? error.message : String(error) },
											});
											return {
												status: 500,
												body: {
													message: msg,
													cause:
														error == null
															? undefined
															: { message: error instanceof Error ? error.message : String(error) },
												},
											} as const;
										}
									}
								}

								const now = Date.now();
								const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((userAuth) => {
									if (!userAuth) {
										return null;
									}

									return ctx.runQuery(internal.users.get, {
										userId: userAuth.id,
									});
								});
								if (!user) {
									return {
										status: 401,
										body: {
											message: "Unauthenticated",
										},
									} as const;
								}

								let threadId = null;
								let createdThreadId = null;

								const requestMessages = body.messages as ai_chat_AiSdk5UiMessage[];
								const uiMessages: ai_chat_AiSdk5UiMessage[] = [];

								if (body.threadId) {
									const existingThread = await ctx.runQuery(api.ai_chat.thread_get, {
										membershipId: membership._id,
										threadId: body.threadId,
									});
									if (!existingThread) {
										return {
											status: 400,
											body: {
												message: "Not found",
											},
										} as const;
									}

									threadId = existingThread._id;
								} else {
									if (!body.clientGeneratedThreadId) {
										throw should_never_happen(
											"`body.clientGeneratedThreadId` missing, the request was not properly validated at the top of this handler",
											{
												threadId,
												clientGeneratedThreadId: body.clientGeneratedThreadId,
											},
										);
									}
								}

								// Check credits after cheap request validation but before any LLM work.
								const lastUserMessage = (body.messages as Array<{ id?: string }>).at(-1);
								const billingEventId = composite_id(
									"billing",
									"ai_usage",
									membership.userId,
									(body.threadId ?? body.clientGeneratedThreadId) as string,
									lastUserMessage?.id ?? body.parentId ?? "turn",
								);
								const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
									userId: membership.userId,
									minimumRequiredCents: 1,
								});
								if (!creditCheck._yay.hasCredits) {
									return {
										status: 402,
										body: {
											message: "Insufficient funds",
										},
									} as const;
								}

								if (!threadId) {
									const created = await ctx.runMutation(api.ai_chat.thread_create, {
										membershipId: membership._id,
										// Store the optimistic client thread id on the persisted thread.
										// This lets the frontend dedupe the optimistic entry as soon as the
										// thread appears in `threads_list`, even if the SSE `data-thread-id`
										// mapping arrives slightly later.
										clientGeneratedId: body.clientGeneratedThreadId ?? get_id_generator("ai_thread")(),
										lastMessageAt: now,
									});

									if (created._nay) {
										return {
											status: 400,
											body: {
												message: created._nay.message,
											},
										} as const;
									}

									createdThreadId = threadId = created._yay.threadId;
								}

								// FIX(parentId-race-condition): Track the resolved Convex doc ID for `onFinish` persistence.
								let resolvedParentId: string | null | undefined = body.parentId;
								let resolvedParentClientGeneratedId: string | null = null;

								if (threadId) {
									do {
										const threadMessagesResult = await ctx.runQuery(api.ai_chat.thread_messages_list, {
											threadId: threadId as app_convex_Id<"ai_chat_threads">,
											membershipId: membership._id,
											order: "asc",
										});

										if (!threadMessagesResult) {
											break;
										}

										// FIX(parentId-race-condition): Index by both Convex doc `_id` and `clientGeneratedMessageId`
										// so lookups work regardless of which ID format the client sends.
										// The client may send a client-generated ID as `body.parentId` when the Convex
										// real-time subscription hasn't delivered the persisted messages yet.
										//
										// BEFORE:
										// const messagesMap = new Map<string, app_convex_Doc<"ai_chat_threads_messages_aisdk_5">>(
										// 	threadMessagesResult.messages.map((msg) => [msg._id, msg]),
										// );
										const messagesMap = new Map<string, app_convex_Doc<"ai_chat_threads_messages_aisdk_5">>();
										for (const msg of threadMessagesResult.messages) {
											messagesMap.set(msg._id, msg);
											if (msg.clientGeneratedMessageId) {
												messagesMap.set(msg.clientGeneratedMessageId, msg);
											}
										}

										const reconstructedMessages: app_convex_Doc<"ai_chat_threads_messages_aisdk_5">[] = [];

										let nextMessageId = body.parentId;
										while (nextMessageId) {
											const message = messagesMap.get(nextMessageId);
											if (!message) {
												throw should_never_happen("Failed to reconstruct messages", {
													threadId,
													messageId: nextMessageId,
												});
											}

											reconstructedMessages.push(message);
											nextMessageId = message.parentId as string;
										}

										// FIX(parentId-race-condition): Resolve `body.parentId` to the Convex doc `_id` so that
										// `onFinish` can persist the parent chain with real doc IDs.
										// Without this, `normalizeId()` in `thread_messages_add` silently returns `null`
										// for client-generated IDs, breaking the parent chain.
										if (body.parentId) {
											const parentMsg = messagesMap.get(body.parentId);
											if (parentMsg) {
												resolvedParentId = parentMsg._id;
												if (parentMsg.clientGeneratedMessageId) {
													resolvedParentClientGeneratedId = parentMsg.clientGeneratedMessageId;
												}
											}
										}

										for (let i = reconstructedMessages.length - 1; i >= 0; i--) {
											const msg = reconstructedMessages[i];
											uiMessages.push({
												...(msg.content as any),
												id: msg._id,
											});
										}
									} while (0);
								}

								// Persist user-submitted messages before starting assistant streaming.
								// This keeps edits durable even when the user stops generation.
								if (requestMessages.length > 0) {
									const persistedRequestMessages = await ctx.runMutation(api.ai_chat.thread_messages_add, {
										membershipId: membership._id,
										threadId: threadId as app_convex_Id<"ai_chat_threads">,
										parentId: resolvedParentId,
										messages: requestMessages.map((message) => ({
											clientGeneratedMessageId: message.id,
											content: message,
										})),
									});

									if (persistedRequestMessages._nay) {
										return {
											status: 403,
											body: {
												message: persistedRequestMessages._nay.message,
											},
										} as const;
									}

									for (let i = 0; i < requestMessages.length; i++) {
										const requestMessage = requestMessages[i];
										const persistedMessageId = persistedRequestMessages._yay.ids[i];
										if (!persistedMessageId) {
											throw should_never_happen("Failed to map request message to persisted message ID", {
												threadId,
												requestMessageId: requestMessage.id,
												index: i,
											});
										}

										uiMessages.push({
											...requestMessage,
											id: persistedMessageId,
										} satisfies ai_chat_AiSdk5UiMessage);
									}

									resolvedParentId = persistedRequestMessages._yay.ids.at(-1) ?? resolvedParentId;
									resolvedParentClientGeneratedId = requestMessages.at(-1)?.id ?? resolvedParentClientGeneratedId;
								}

								const modelMessages = convertToModelMessages(uiMessages, {
									ignoreIncompleteToolCalls: true,
								});

								let didStreamError = false;
								// Captured by `streamText.onFinish` below so `createUIMessageStream.onFinish`
								// can emit one direct Polar usage event with the actual token cost.
								let capturedUsage: { inputTokens: number; outputTokens: number } | null = null;
								let capturedActualCents = 0;

								const stream = createUIMessageStream<ai_chat_AiSdk5UiMessage>({
									generateId: get_id_generator("ai_message"),
									execute: async ({ writer }) => {
										// TODO(ai-chat): If we allocate Convex message docs up front, emit a transient `data-message-ids`
										// part here (while `writer` is available) so the client can swap optimistic UIMessage ids to
										// Convex ids and/or drop optimistic messages immediately, without persisting client ids in DB.
										if (createdThreadId) {
											writer.write({
												type: "data-thread-id",
												data: {
													threadId: createdThreadId,
												},
												transient: true,
											});
										}

										writer.write({
											type: "message-metadata",
											messageMetadata: {
												convexParentId: uiMessages.at(-1)?.id,
												parentClientGeneratedId: resolvedParentClientGeneratedId,
											},
										});

										const result1 = streamText({
											model: openai(body.model),
											system: systemPrompt,
											messages: modelMessages,
											maxOutputTokens: 2000,
											abortSignal: request.signal,
											activeTools,
											experimental_repairToolCall: async (failed) => {
												const lowerToolName = failed.toolCall.toolName.toLowerCase();
												if (lowerToolName !== failed.toolCall.toolName && lowerToolName in tools) {
													return {
														...failed.toolCall,
														toolName: lowerToolName,
													};
												}

												return {
													...failed.toolCall,
													input: JSON.stringify({
														tool: failed.toolCall.toolName,
														error: failed.error.message,
													}),
													toolName: "invalid",
												};
											},
											toolChoice: "auto",
											stopWhen: stepCountIs(10),
											tools,
											onAbort: async () => {
												console.info("streamText.onAbort", {
													threadId,
													parentId: resolvedParentId,
													requestSignalAborted: request.signal.aborted,
												});
											},
											onFinish: async ({ totalUsage }) => {
												// Aggregated across all steps; read by createUIMessageStream.onFinish
												// to emit one direct usage event with the actual cost.
												capturedUsage = {
													inputTokens: totalUsage.inputTokens ?? 0,
													outputTokens: totalUsage.outputTokens ?? 0,
												};
												capturedActualCents += compute_token_usage_cost_cents({
													modelId: body.model,
													inputTokens: capturedUsage.inputTokens,
													outputTokens: capturedUsage.outputTokens,
												});
											},
										});

										const ui_message_stream = result1.toUIMessageStream<ai_chat_AiSdk5UiMessage>();
										writer.merge(ui_message_stream);

										if (request.signal.aborted) {
											return;
										}

										const response1 = await result1.response;

										if (request.signal.aborted) {
											return;
										}

										const thread = await ctx.runQuery(api.ai_chat.thread_get, {
											membershipId: membership._id,
											threadId,
										});
										const existingTitle = typeof thread?.title === "string" ? thread.title.trim() : "";

										// Generate a title for the new thread
										if (thread && !existingTitle) {
											if (request.signal.aborted) {
												return;
											}

											const titleMessages = [...modelMessages, ...response1.messages];
											const titleResult = streamText({
												model: openai(ai_chat_TITLE_MODEL_ID),
												system: ai_chat_TITLE_SYSTEM_PROMPT,
												messages: titleMessages,
												stopWhen: stepCountIs(1),
												temperature: 0.3,
												maxOutputTokens: 50,
												abortSignal: request.signal,
												onFinish: async ({ totalUsage }) => {
													const titleUsage = {
														inputTokens: totalUsage.inputTokens ?? 0,
														outputTokens: totalUsage.outputTokens ?? 0,
													};
													capturedUsage = capturedUsage
														? {
																inputTokens: capturedUsage.inputTokens + titleUsage.inputTokens,
																outputTokens: capturedUsage.outputTokens + titleUsage.outputTokens,
															}
														: titleUsage;
													capturedActualCents += compute_token_usage_cost_cents({
														modelId: ai_chat_TITLE_MODEL_ID,
														inputTokens: titleUsage.inputTokens,
														outputTokens: titleUsage.outputTokens,
													});
												},
											});

											const reader = titleResult.textStream.getReader();
											let title = "";
											while (true) {
												const { value, done } = await reader.read();
												if (done) {
													break;
												}

												if (value) {
													title += value;
												}
											}

											const trimmedTitle = title.trim();
											if (trimmedTitle) {
												writer.write({
													type: "data-chat-title",
													data: { title: trimmedTitle },
													transient: true,
												});

												const threadUpdateResult = await ctx.runMutation(api.ai_chat.thread_update, {
													threadId: thread._id,
													membershipId: membership._id,
													title: trimmedTitle,
												});
												if (threadUpdateResult._nay) {
													console.error("Failed to persist generated title", {
														threadId: thread._id,
														result: threadUpdateResult,
													});
												}
											}
										}
									},
									onError: (error: unknown) => {
										didStreamError = true;
										console.error("AI chat stream error:", error);
										return error instanceof Error ? error.message : String(error);
									},
									onFinish: async (result) => {
										if (!result.responseMessage) {
											return;
										}

										if (result.isAborted) {
											console.info("onFinish aborted", {
												threadId,
												parentId: resolvedParentId,
												isAborted: result.isAborted,
												didStreamError,
												hasResponseMessage: Boolean(result.responseMessage),
											});
											return;
										}

										const capturedInputTokens = capturedUsage?.inputTokens ?? 0;
										const capturedOutputTokens = capturedUsage?.outputTokens ?? 0;
										const capturedTotalTokens = capturedInputTokens + capturedOutputTokens;
										if (capturedTotalTokens > 0 && !didStreamError) {
											await billing_ingest_events(ctx, {
												userEvents: [
													{
														user,
														event: billing_event({
															name: "ai_usage",
															externalCustomerId: membership.userId,
															externalId: billingEventId,
															metadata: {
																amount: capturedActualCents,
																modelId: body.model,
																inputTokens: capturedInputTokens,
																outputTokens: capturedOutputTokens,
																threadId: String(threadId ?? ""),
																messageId: String(result.responseMessage.id ?? ""),
															},
														}),
													},
												],
											});
										}

										const responseMessage = {
											...result.responseMessage,
											...(result.isAborted || didStreamError
												? {
														metadata: {
															...(result.responseMessage.metadata ?? {}),
															status: result.isAborted ? ("aborted" as const) : ("errored" as const),
															parentClientGeneratedId: result.responseMessage.metadata?.parentClientGeneratedId ?? null,
														},
													}
												: {}),
										} satisfies ai_chat_AiSdk5UiMessage;

										// Persist completed assistant responses below the last persisted request message.
										const assistantPersistResult = await ctx.runMutation(api.ai_chat.thread_messages_add, {
											membershipId: membership._id,
											threadId: threadId as app_convex_Id<"ai_chat_threads">,
											parentId: resolvedParentId,
											messages: [
												{
													clientGeneratedMessageId: responseMessage.id,
													content: responseMessage,
												},
											],
										});

										if (assistantPersistResult._nay) {
											throw new Error("Failed to persist assistant message", {
												cause: assistantPersistResult._nay,
											});
										}
									},
								});

								return {
									status: 200,
									body: stream,
								} as const;
							} catch (error) {
								const message = "AI chat stream error";
								console.error(`${message}:`, error);

								return {
									status: 500,
									body: {
										message: "Internal server error",
										cause:
											error == null ? undefined : { message: error instanceof Error ? error.message : String(error) },
									},
								} as const;
							}
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);

								if (result.status === 200) {
									return createUIMessageStreamResponse({
										status: result.status,
										stream: result.body,
										consumeSseStream: consumeStream,
									});
								}

								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),

		...((/* iife */ path = "/api/v1/runs/stream" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						/**
						 * See {@link PrepareSendMessagesRequest}.
						 *
						 * See {@link AssistantChatTransport.prepareSendMessagesRequest}.
						 **/
						const bodyValidator = z.object({
							/**
							 * Authenticated membership scope.
							 *
							 * Server derives workspace/project from this row.
							 **/
							membershipId: z.string(),
							thread_id: z.string(),
							assistant_id: z.string(),
							messages: z.array(z.any()),
							response_format: z.string().optional(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							try {
								const requestParseResult = await server_request_json_parse_and_validate(request, bodyValidator);

								if (requestParseResult._nay) {
									return {
										status: 400,
										body: requestParseResult._nay,
									} as const;
								}

								const body = requestParseResult._yay;

								if (body.assistant_id !== "system/thread_title") {
									return {
										status: 400,
										body: {
											message: "Invalid stream ID",
										},
									} as const;
								}

								const membership = await ctx.runQuery(api.workspaces.get_membership_from_string, {
									membershipId: body.membershipId,
								});

								if (!membership) {
									return {
										status: 403,
										body: {
											message: "Unauthorized",
										},
									} as const;
								}

								const messages = body.messages || [];
								const thread_id = body.thread_id;

								// Extract conversation text from messages for title generation
								const conversation_text = messages
									.map((msg: any) =>
										[
											`${msg.role}:`,
											Array.isArray(msg.content) ? msg.content.map((part: any) => part.text).join(" ") : msg.content,
										]
											.filter(Boolean)
											.join(" "),
									)
									.filter(Boolean)
									.join("\n");

								const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((userAuth) => {
									if (!userAuth) {
										return null;
									}

									return ctx.runQuery(internal.users.get, {
										userId: userAuth.id,
									});
								});
								if (!user) {
									return {
										status: 401,
										body: {
											message: "Unauthenticated",
										},
									} as const;
								}

								const billingEventId = composite_id("billing", "ai_usage", membership.userId, thread_id, "title");

								// Check credits before title generation. One title per thread; the literal
								// "title" discriminator keeps the usage event id stable across HTTP retries.
								const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
									userId: membership.userId,
									minimumRequiredCents: 1,
								});
								if (!creditCheck._yay.hasCredits) {
									return {
										status: 402,
										body: { message: "Insufficient funds" },
									} as const;
								}

								let titleCapturedUsage: { inputTokens: number; outputTokens: number } | null = null;

								// Generate title using AI with streaming
								const result = streamText({
									model: openai(ai_chat_TITLE_MODEL_ID),
									system: ai_chat_TITLE_SYSTEM_PROMPT,
									messages: [
										{
											role: "user",
											content: `Generate a title for this conversation:\n\n${conversation_text}`,
										},
									],
									stopWhen: stepCountIs(1),
									temperature: 0.3,
									maxOutputTokens: 50,
									experimental_transform: smoothStream({
										delayInMs: 100,
									}),
									onFinish: async ({ totalUsage }) => {
										titleCapturedUsage = {
											inputTokens: totalUsage.inputTokens ?? 0,
											outputTokens: totalUsage.outputTokens ?? 0,
										};
									},
								});

								// Transform the AI stream to properly encode text chunks
								let title = "";

								// Trigger mutation when the stream is finished
								const transform_stream = new TransformStream({
									transform(chunk, controller) {
										title += chunk;
										controller.enqueue(chunk);
									},
									flush: async () => {
										const capturedInputTokens = titleCapturedUsage?.inputTokens ?? 0;
										const capturedOutputTokens = titleCapturedUsage?.outputTokens ?? 0;
										const capturedTotalTokens = capturedInputTokens + capturedOutputTokens;
										if (capturedTotalTokens > 0) {
											const titleCostCents = compute_token_usage_cost_cents({
												modelId: ai_chat_TITLE_MODEL_ID,
												inputTokens: capturedInputTokens,
												outputTokens: capturedOutputTokens,
											});
											await billing_ingest_events(ctx, {
												userEvents: [
													{
														user,
														event: billing_event({
															name: "ai_usage",
															externalCustomerId: membership.userId,
															externalId: billingEventId,
															metadata: {
																amount: titleCostCents,
																modelId: ai_chat_TITLE_MODEL_ID,
																inputTokens: capturedInputTokens,
																outputTokens: capturedOutputTokens,
																threadId: thread_id,
																messageId: "title",
															},
														}),
													},
												],
											});
										}

										const trimmedTitle = title.trim();
										if (!trimmedTitle) {
											return;
										}

										const threadUpdateResult = await ctx.runMutation(api.ai_chat.thread_update, {
											membershipId: membership._id,
											threadId: thread_id,
											title: trimmedTitle,
										});

										if (threadUpdateResult._nay) {
											console.error("Failed to persist generated title", {
												threadId: thread_id,
												result: threadUpdateResult,
											});
										}
									},
								});

								// Pipe the AI textStream through the transformer, insprired by ai-sdk's `createTextStreamResponse`
								const stream = result.textStream.pipeThrough(transform_stream).pipeThrough(new TextEncoderStream());

								void result.consumeStream();

								return {
									status: 200,
									body: stream,
								} as const;
							} catch (error) {
								const message = "Title generation error";
								console.error(`${message}:`, error);

								return {
									status: 500,
									body: {
										message,
										cause:
											error == null ? undefined : { message: error instanceof Error ? error.message : String(error) },
									},
								} as const;
							}
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);

								if (result.status === 200) {
									return new Response(result.body, {
										status: result.status,
									});
								}

								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}

// Vitest sets NODE_ENV to "test"; Convex's bundler defines it as "production",
// so keep that check first to let esbuild erase `import.meta.vitest` before analysis.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect, vi } = import.meta.vitest;

	type ai_chat_get_agent_configuration_test_user_identity = NonNullable<
		Awaited<ReturnType<ActionCtx["auth"]["getUserIdentity"]>>
	>;

	const ai_chat_get_agent_configuration_test_ctx_data = {
		workspaceId: "app_workspace_test_1",
		projectId: "app_project_test_1",
		userId: "user_1" as app_convex_Id<"users">,
	} as const;

	const ai_chat_get_agent_configuration_test_user_identity_default = {
		issuer: "https://clerk.test",
		subject: "subject-user-1",
		external_id: "user_1",
		name: "Test User",
	} as unknown as ai_chat_get_agent_configuration_test_user_identity;

	const ai_chat_get_agent_configuration_expected_tool_keys = [
		"read_page",
		"list_pages",
		"glob_pages",
		"grep_pages",
		"text_search_pages",
		"write_page",
		"edit_page",
		"web_search",
	] as const;

	const makeCtx = (args?: {
		runQueryImpl?: (...fnArgs: unknown[]) => Promise<unknown>;
		runMutationImpl?: (...fnArgs: unknown[]) => Promise<unknown>;
		userIdentity?: ai_chat_get_agent_configuration_test_user_identity;
	}) => {
		const runQuery = vi.fn(args?.runQueryImpl ?? (async () => null));
		const runMutation = vi.fn(args?.runMutationImpl ?? (async () => null));
		const getUserIdentity = vi.fn(
			async () => args?.userIdentity ?? ai_chat_get_agent_configuration_test_user_identity_default,
		);
		const ctx = {
			runQuery,
			runMutation,
			auth: {
				getUserIdentity,
			},
		} as unknown as ActionCtx;

		return {
			ctx,
			runQuery,
			runMutation,
			getUserIdentity,
		};
	};

	describe("ai_chat_get_agent_configuration", () => {
		test("returns the full tool registry and keeps write tools active in Agent mode", () => {
			const { ctx } = makeCtx();
			const configuration = ai_chat_get_agent_configuration({
				ctx,
				ctxData: ai_chat_get_agent_configuration_test_ctx_data,
				args: {
					modeId: "agent",
				},
			});

			expect(Object.keys(configuration.tools)).toEqual(ai_chat_get_agent_configuration_expected_tool_keys);
			expect(configuration.activeTools).toEqual(ai_chat_get_agent_configuration_expected_tool_keys);
		});

		test("keeps the full tool registry but excludes write tools from activeTools in Ask mode", () => {
			const { ctx } = makeCtx();
			const configuration = ai_chat_get_agent_configuration({
				ctx,
				ctxData: ai_chat_get_agent_configuration_test_ctx_data,
				args: {
					modeId: "ask",
				},
			});

			expect(Object.keys(configuration.tools)).toEqual(ai_chat_get_agent_configuration_expected_tool_keys);
			expect(configuration.activeTools).toEqual([
				"read_page",
				"list_pages",
				"glob_pages",
				"grep_pages",
				"text_search_pages",
				"web_search",
			]);
		});

		test("appends the Ask mode instruction to the system prompt", () => {
			const { ctx } = makeCtx();
			const configuration = ai_chat_get_agent_configuration({
				ctx,
				ctxData: ai_chat_get_agent_configuration_test_ctx_data,
				args: {
					modeId: "ask",
				},
			});

			expect(configuration.systemPrompt).toContain(
				"You are in Ask mode: do not call `write_page` or `edit_page`. Answer from reads and searches only.",
			);
		});

		test("keeps the returned tool keys aligned with the current runtime registry", () => {
			const { ctx } = makeCtx();
			const configuration = ai_chat_get_agent_configuration({
				ctx,
				ctxData: ai_chat_get_agent_configuration_test_ctx_data,
				args: {
					modeId: "agent",
				},
			});

			expect(Object.keys(configuration.tools)).toEqual(ai_chat_get_agent_configuration_expected_tool_keys);
		});
	});
}
