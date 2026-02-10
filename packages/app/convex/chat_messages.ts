import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

/**
 * Creates a new root message (thread head) in the chat_messages table.
 *
 * @returns { threadId } - The ID of the newly created root message
 */
export const chat_messages_threads_create = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		content: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const threadId = await ctx.db.insert("chat_messages", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: null,
			parentId: null,
			isArchived: false,
			createdBy: user.name,
			content: args.content,
		});

		return { threadId };
	},
});

/**
 * Appends a new child message to an existing thread root.
 *
 * @returns { messageId } - The ID of the newly created child message
 */
export const chat_messages_add = mutation({
	args: {
		rootId: v.id("chat_messages"),
		content: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const root = await ctx.db.get("chat_messages", args.rootId);
		if (!root) {
			throw new Error("Root message not found");
		}

		const messageId = await ctx.db.insert("chat_messages", {
			workspaceId: root.workspaceId,
			projectId: root.projectId,
			threadId: args.rootId,
			parentId: args.rootId,
			isArchived: false,
			createdBy: user.name,
			content: args.content,
		});

		return { messageId };
	},
});

/**
 * Lists messages in a thread using indexed reads.
 *
 * Returns root + children in oldest→newest order by Convex insertion order.
 */
export const chat_messages_list = query({
	args: {
		threadId: v.id("chat_messages"),
		limit: v.number(),
	},
	handler: async (ctx, args) => {
		const root = await ctx.db.get("chat_messages", args.threadId);
		if (!root || root.isArchived) {
			return { messages: [] };
		}

		const children = await ctx.db
			.query("chat_messages")
			.withIndex("by_workspace_project_thread", (q) =>
				q.eq("workspaceId", root.workspaceId).eq("projectId", root.projectId).eq("threadId", args.threadId),
			)
			.order("asc")
			.take(Math.max(0, args.limit - 1));

		const visibleChildren = children.filter((message) => !message.isArchived);

		return {
			messages: [root, ...visibleChildren],
		};
	},
});

/**
 * Soft archives a message by setting isArchived = true.
 */
export const chat_messages_archive = mutation({
	args: {
		messageId: v.id("chat_messages"),
	},
	handler: async (ctx, args) => {
		const message = await ctx.db.get("chat_messages", args.messageId);
		if (!message) {
			throw new Error("Message not found");
		}

		await ctx.db.patch("chat_messages", args.messageId, {
			isArchived: true,
		});

		return { success: true };
	},
});

/**
 * Gets a single message by ID.
 */
export const chat_messages_get = query({
	args: {
		messageId: v.id("chat_messages"),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get("chat_messages", args.messageId);
	},
});

/**
 * Lists thread heads for the given IDs.
 */
export const chat_messages_threads_list = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		threadIds: v.array(v.string()),
		isArchived: v.optional(v.union(v.boolean(), v.null())),
	},
	returns: {
		threads: v.array(
			v.object({
				id: v.id("chat_messages"),
				createdAt: v.number(),
				lastMessageAt: v.number(),
				content: v.string(),
				createdBy: v.string(),
				isArchived: v.boolean(),
			}),
		),
	},
	handler: async (ctx, args) => {
		const threadIds = args.threadIds
			.map((threadId) => ctx.db.normalizeId("chat_messages", threadId))
			.filter((threadId) => threadId != null);

		const threads = await Promise.all(
			threadIds.map((threadId) =>
				ctx.db.get("chat_messages", threadId).then(async (message) => {
					if (!message) {
						return null;
					}

					if (message.workspaceId !== args.workspaceId || message.projectId !== args.projectId) {
						return null;
					}

					if (args.isArchived !== undefined && args.isArchived !== null) {
						if (message.isArchived !== args.isArchived) {
							return null;
						}
					}

					const lastChild = await ctx.db
						.query("chat_messages")
						.withIndex("by_workspace_project_thread", (q) =>
							q.eq("workspaceId", message.workspaceId).eq("projectId", message.projectId).eq("threadId", message._id),
						)
						.order("desc")
						.first();

					const lastMessageAt = lastChild?._creationTime ?? message._creationTime;

					return {
						id: message._id,
						createdAt: message._creationTime,
						lastMessageAt,
						content: message.content,
						createdBy: message.createdBy,
						isArchived: message.isArchived,
					};
				}),
			),
		).then((values) => values.filter((value) => value != null));

		return { threads };
	},
});
