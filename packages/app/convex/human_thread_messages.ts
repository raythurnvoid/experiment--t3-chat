import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

/**
 * Creates a new root message (thread head) in the human_thread_messages table.
 *
 * Root messages act as thread heads and can have child messages appended to them.
 *
 * @returns { thread_id } - The ID of the newly created root message that works as a thread id
 */
export const human_thread_messages_threads_create = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		content: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const thread_id = await ctx.db.insert("human_thread_messages", {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			thread_id: null,
			parent_id: null,
			last_child_id: null,
			is_archived: false,
			created_by: user.id,
			content: args.content,
		});

		return { thread_id };
	},
});

/**
 * Appends a new child message to an existing thread (root message).
 *
 * The new message is linked to the previous last child (or the root if no children exist).
 *
 * Updates the root's last_child_id to point to the new message.
 *
 * @returns { message_id } - The ID of the newly created child message
 */
export const human_thread_messages_add = mutation({
	args: {
		rootId: v.id("human_thread_messages"),
		content: v.string(),
	},
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		// Load the root message
		const root = await ctx.db.get(args.rootId);
		if (!root) {
			throw new Error("Root message not found");
		}

		// Root messages have thread_id = null
		if (root.thread_id !== null) {
			throw new Error("Cannot append to a non-root message");
		}

		// Determine parent_id: first child points to root, subsequent children point to previous child
		const parentId = root.last_child_id ?? args.rootId;

		// Insert the new child message
		const messageId = await ctx.db.insert("human_thread_messages", {
			workspace_id: root.workspace_id,
			project_id: root.project_id,
			thread_id: args.rootId,
			parent_id: parentId,
			last_child_id: null, // Children don't track their own children
			is_archived: false,
			created_by: user.id,
			content: args.content,
		});

		// Update the root's last_child_id to point to the new message
		await ctx.db.patch(args.rootId, {
			last_child_id: messageId,
		});

		return { message_id: messageId };
	},
});

/**
 * Lists the latest messages in a thread by walking backwards from last_child_id.
 *
 * Returns messages in oldest→newest order (reversed from the traversal order).
 *
 * @returns { messages } - Array of messages including the root, in chronological order
 */
export const human_thread_messages_list = query({
	args: {
		threadId: v.id("human_thread_messages"),
		limit: v.number(),
	},
	handler: async (ctx, args) => {
		// Load the root message
		const root = await ctx.db.get(args.threadId);
		if (!root || root.is_archived) {
			return { messages: [] };
		}

		// Root messages have thread_id = null
		if (root.thread_id !== null) {
			return { messages: [] };
		}

		const messages: Array<{
			_id: Id<"human_thread_messages">;
			_creationTime: number;
			workspace_id: string;
			project_id: string;
			thread_id: Id<"human_thread_messages"> | null;
			parent_id: Id<"human_thread_messages"> | null;
			last_child_id: Id<"human_thread_messages"> | null;
			is_archived: boolean;
			created_by: string;
			content: string;
		}> = [];

		// Start from the last child and walk backwards
		let currentId: Id<"human_thread_messages"> | null = root.last_child_id;
		let count = 0;

		while (currentId !== null && count < args.limit - 1) {
			const message = await ctx.db.get(currentId);
			if (!message || message.is_archived) {
				break;
			}

			messages.push(message);
			count++;

			// Move to the previous message in the chain
			// Stop if we've reached the root (parent_id === rootId)
			if (message.parent_id === args.threadId) {
				break;
			}
			currentId = message.parent_id;
		}

		// Reverse to get oldest→newest order
		messages.reverse();

		// Include the root at the beginning
		messages.unshift(root);

		return { messages };
	},
});

/**
 * Soft archives a message by setting is_archived = true.
 *
 * When a root message is archived, its thread won't show up in UIs.
 */
export const human_thread_messages_archive = mutation({
	args: {
		messageId: v.id("human_thread_messages"),
	},
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.messageId);
		if (!message) {
			throw new Error("Message not found");
		}

		await ctx.db.patch(args.messageId, {
			is_archived: true,
		});

		return { success: true };
	},
});

/**
 * Gets a single message by ID.
 */
export const human_thread_messages_get = query({
	args: {
		messageId: v.id("human_thread_messages"),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.messageId);
	},
});

/**
 * Lists root messages (thread heads) for the given IDs.
 *
 * Returns the full document of root messages that match the provided IDs and optional archive filter.
 * Only root messages (thread_id = null) are returned.
 * Filters by workspace_id and project_id to ensure access control.
 *
 * @returns Array of root message documents
 */
export const human_thread_messages_threads_list = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		threadIds: v.array(v.string()),
		isArchived: v.optional(v.union(v.boolean(), v.null())),
	},
	returns: {
		threads: v.array(
			v.object({
				id: v.id("human_thread_messages"),
				created_at: v.number(),
				content: v.string(),
				created_by: v.string(),
				is_archived: v.boolean(),
				last_child_id: v.union(v.id("human_thread_messages"), v.null()),
			}),
		),
	},
	handler: async (ctx, args) => {
		const threadIds = args.threadIds
			.map((threadId) => ctx.db.normalizeId("human_thread_messages", threadId))
			.filter((threadId) => threadId != null);

		// Fetch all threads by ID using Promise.all (cannot index by _id)
		const messages = await Promise.all(threadIds.map((threadId) => ctx.db.get(threadId)));

		// Filter by workspace_id, project_id, is_archived, and ensure root messages only
		const threads = messages.filter((message): message is NonNullable<typeof message> => {
			// Skip if message doesn't exist
			if (!message) {
				return false;
			}

			// Access control: filter by workspace_id and project_id
			if (message.workspace_id !== args.workspaceId || message.project_id !== args.projectId) {
				return false;
			}

			// Only return root messages (thread_id = null)
			if (message.thread_id !== null) {
				return false;
			}

			// Apply is_archived filter if provided (not null/undefined)
			if (args.isArchived !== undefined && args.isArchived !== null) {
				if (message.is_archived !== args.isArchived) {
					return false;
				}
			}

			return true;
		});

		return {
			threads: threads.map((thread) => ({
				id: thread._id,
				created_at: thread._creationTime,
				content: thread.content,
				created_by: thread.created_by,
				is_archived: thread.is_archived,
				last_child_id: thread.last_child_id,
			})),
		};
	},
});
