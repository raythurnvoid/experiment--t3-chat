import {
	ai_chat_HARDCODED_PROJECT_ID,
	ai_chat_HARDCODED_WORKSPACE_ID,
} from "../src/lib/ai_chat.ts";
import { math_clamp } from "../src/lib/utils.ts";
import { query, mutation } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import app_convex_schema from "./schema.ts";

/**
 * Query to list all threads for a workspace with pagination
 */
export const threads_list = query({
	args: {
		paginationOpts: paginationOptsValidator,
		includeArchived: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		args.paginationOpts.numItems = math_clamp(
			args.paginationOpts.numItems,
			1,
			50
		);

		let threadsQuery = ctx.db
			.query("threads")
			.withIndex("by_workspace", (q) =>
				q.eq("workspace_id", ai_chat_HARDCODED_WORKSPACE_ID)
			);

		if (args.includeArchived !== true) {
			threadsQuery = threadsQuery.filter((q) =>
				q.eq(q.field("archived"), false)
			);
		}

		const result = await threadsQuery
			.order("desc")
			.paginate(args.paginationOpts);

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
		const { created_by = "anonymous" } = args;

		const now = Date.now();

		const thread_id = await ctx.db.insert("threads", {
			title: args.title ?? "New Chat",
			last_message_at: args.last_message_at,
			archived: false,
			workspace_id: ai_chat_HARDCODED_WORKSPACE_ID,
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
		const { thread_id, title, updated_by = "anonymous" } = args;
		const now = Date.now();

		const updateData: {
			updated_by: string;
			updated_at: number;
			title?: string;
		} = {
			updated_by,
			updated_at: now,
		};

		if (title !== undefined) {
			updateData.title = title;
		}

		await ctx.db.patch(thread_id, updateData);
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
			updated_by: args.updated_by ?? "anonymous",
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

		const anonymous = "anonymous";

		// Insert the message
		const message_id = await ctx.db.insert("messages", {
			parent_id: args.parent_id,
			thread_id: args.thread_id,
			created_by: args.created_by ?? anonymous,
			updated_by: args.created_by ?? anonymous,
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
				updated_by: args.created_by ?? anonymous,
			});
		} catch (error) {
			console.error("Failed to update thread when adding message", error);
		}

		return { message_id };
	},
});
