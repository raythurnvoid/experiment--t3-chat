import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import type { ai_chat_AiSdk5UiMessage } from "../src/lib/ai-chat.ts";

const app_convex_schema = defineSchema({
	// #region AI
	ai_chat_threads: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),

		/**
		 * Necessary to link the optimistic update to the persisted thread
		 **/
		clientGeneratedId: v.string(),
		title: v.union(v.string(), v.null()),
		archived: v.boolean(),
		starred: v.optional(v.boolean()),

		runtime: v.literal("aisdk_5"),

		createdBy: v.id("users"),
		updatedBy: v.id("users"),
		/**
		 * timestamp in milliseconds
		 **/
		updatedAt: v.number(),
		/**
		 * timestamp in milliseconds
		 **/
		lastMessageAt: v.optional(v.number()),
	}).index("by_workspace_project_archived_last_message_at", ["workspaceId", "projectId", "archived", "lastMessageAt"]),

	/**
	 * Each doc should be compatible with {@link ai_chat_AiSdk5UiMessage}.
	 */
	ai_chat_threads_messages_aisdk_5: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),

		/**
		 * Root messages have `parent_id: null`.
		 */
		parentId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
		threadId: v.id("ai_chat_threads"),

		/**
		 * Necessary to link the optimistic update to the persisted message.
		 */
		clientGeneratedMessageId: v.optional(v.string()),

		/**
		 * AI SDK 5 {@link ai_chat_AiSdk5UiMessage}.
		 **/
		content: v.record(v.string(), v.any()),

		createdBy: v.id("users"),
		/** timestamp in milliseconds */
		updatedAt: v.number(),
	}).index("by_workspace_project_thread", ["workspaceId", "projectId", "threadId"]),

	/**
	 * Pending edits overlay used to stage AI-written content until user saves.
	 * Keys by user/thread/page to allow parallel staging across chat threads.
	 */
	ai_chat_pending_edits: defineTable({
		workspace_id: v.string(),
		project_id: v.string(),
		user_id: v.string(),
		thread_id: v.string(),
		page_id: v.string(),
		base_content: v.string(),
		modified_content: v.string(),
		updated_at: v.number(),
	})
		.index("by_user_thread_page", ["user_id", "thread_id", "page_id"])
		.index("by_page", ["page_id"]),

	/**
	 * Tracks scheduled cleanup tasks to remove a user's pending edits.
	 * One task per user; canceled on heartbeat, executed if user remains offline.
	 */
	ai_chat_pending_edits_cleanup_tasks: defineTable({
		user_id: v.string(),
		scheduled_function_id: v.id("_scheduled_functions"),
	}).index("by_user_id", ["user_id"]),
	// #endregion AI

	// #region Pages
	pages: defineTable({
		/** Workspace ID extracted from roomId */
		workspace_id: v.string(),
		/** Project ID extracted from roomId */
		project_id: v.string(),
		/** Document ID generated client side */
		page_id: v.string(),
		/** Display name used in path resolution */
		name: v.string(),
		/** ID of the markdown content for the page */
		markdown_content_id: v.optional(v.id("pages_markdown_content")),
		/** ID of the last YJS sequence for the page */
		yjs_last_sequence_id: v.optional(v.id("pages_yjs_docs_last_sequences")),
		/** ID of the last YJS sequence for the page */
		yjs_snapshot_id: v.optional(v.id("pages_yjs_snapshots")),
		/** Document version - always 0 for now until versioning is implemented */
		version: v.number(),
		/** Whether document is archived */
		is_archived: v.boolean(),
		/** "root" for root items */
		parent_id: v.string(),
		/** Created by user ID */
		created_by: v.string(),
		/** Updated by user ID */
		updated_by: v.string(),
		/** timestamp in milliseconds when document was last updated */
		updated_at: v.number(),
	})
		.index("by_workspace_project_and_page_id", ["workspace_id", "project_id", "page_id"])
		.index("by_workspace_project_parent_id_and_name", ["workspace_id", "project_id", "parent_id", "name"])
		.index("by_workspace_project_parent_id_and_is_archived", ["workspace_id", "project_id", "parent_id", "is_archived"])
		.index("by_workspace_project_and_name", ["workspace_id", "project_id", "name"]),
	/**
	 * Table to store markdown content for pages.
	 */
	pages_markdown_content: defineTable({
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.id("pages"),
		/** Markdown content */
		content: v.string(),
		/** Whether document is archived */
		is_archived: v.boolean(),
		/** YJS sequence to know the sync status */
		yjs_sequence: v.number(),
		updated_at: v.number(),
		updated_by: v.string(),
	}).searchIndex("search_by_content", {
		searchField: "content",
		filterFields: ["workspace_id", "project_id", "is_archived"],
	}),

	pages_yjs_snapshots: defineTable({
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.id("pages"),
		sequence: v.number(),
		snapshot_update: v.bytes(),
		created_by: v.string(),
		updated_by: v.string(),
		updated_at: v.number(),
	}).index("by_workspace_project_and_page_id_and_sequence", ["workspace_id", "project_id", "page_id", "sequence"]),

	pages_yjs_updates: defineTable({
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.id("pages"),
		sequence: v.number(),
		update: v.bytes(),
		origin: v.union(
			v.object({
				type: v.literal("USER_EDIT"),
				/**
				 * Even though sessions are destroyed when users disconnect, this
				 * is usedful to differentiate between local and remote edits.
				 */
				session_id: v.string(),
			}),
			v.object({
				type: v.literal("USER_SNAPSHOT_RESTORE"),
				snapshot_id: v.id("pages_snapshots"),
			}),
			v.object({
				type: v.literal("USER_AI_EDIT"),
			}),
		),
		created_by: v.string(),
		created_at: v.number(),
	}).index("by_workspace_project_and_page_id_and_sequence", ["workspace_id", "project_id", "page_id", "sequence"]),

	pages_yjs_docs_last_sequences: defineTable({
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.id("pages"),
		last_sequence: v.number(),
	}).index("by_workspace_project_and_page_id", ["workspace_id", "project_id", "page_id"]),

	/**
	 * Internal table to track scheduled YJS snapshot updates.
	 */
	pages_yjs_snapshot_schedules: defineTable({
		page_id: v.id("pages"),
		scheduled_function_id: v.id("_scheduled_functions"),
	}).index("by_page_id", ["page_id"]),

	pages_snapshots: defineTable({
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.id("pages"),
		created_by: v.id("users"),
		is_archived: v.optional(v.boolean()),
	})
		.index("by_page_id", ["page_id"])
		.index("by_page_id_and_is_archived", ["page_id", "is_archived"])
		.index("by_workspace_project", ["workspace_id", "project_id"]),

	pages_snapshots_contents: defineTable({
		workspace_id: v.string(),
		project_id: v.string(),
		page_snapshot_id: v.id("pages_snapshots"),
		content: v.string(),
		page_id: v.id("pages"),
	}).index("by_workspace_project_and_page_snapshot_id", ["workspace_id", "project_id", "page_snapshot_id"]),
	// #endregion Pages

	// #region Human Threads
	/**
	 * Human thread messages table - a single table that represents both threads and messages.
	 * Root messages (thread_id = null) act as thread heads.
	 * Child messages (thread_id = rootId) form a linked list via parent_id.
	 */
	human_thread_messages: defineTable({
		/** Workspace ID for multi-tenant scoping */
		workspace_id: v.string(),
		/** Project ID for multi-tenant scoping */
		project_id: v.string(),
		/**
		 * null → this row is a root message (thread head).
		 * non-null → this row is a child message belonging to the root whose id is thread_id.
		 */
		thread_id: v.union(v.id("human_thread_messages"), v.null()),
		/**
		 * null for roots.
		 * For children: points to the previous message in that thread's linear chain.
		 */
		parent_id: v.union(v.id("human_thread_messages"), v.null()),
		/**
		 * Only meaningful on roots: id of the last child in the chain, or null if there are no children.
		 */
		last_child_id: v.union(v.id("human_thread_messages"), v.null()),
		/** Soft delete / hide flag, especially for root messages */
		is_archived: v.boolean(),
		/** User ID who created this message */
		created_by: v.string(),
		/** Markdown content; produced from TipTap rich text on submit */
		content: v.string(),
	}),
	// #endregion Human Threads

	// #region Users
	users: defineTable({
		/** Clerk user ID, null for anonymous users */
		clerkUserId: v.union(v.string(), v.null()),
		/** Anonymous auth JWT; null once upgraded */
		anonymousAuthToken: v.union(v.string(), v.null()),
		anagraphic: v.optional(v.id("users_anagraphics")),
	}).index("by_clerk_user_id", ["clerkUserId"]),

	users_anagraphics: defineTable({
		userId: v.id("users"),
		/** Display name, e.g. "Anonymous user <id>" for anonymous users */
		displayName: v.string(),
		avatarUrl: v.optional(v.string()),
		updatedAt: v.number(),
	}),
	// #endregion Users
});

export default app_convex_schema;

export { app_convex_schema };

// @ts-expect-error unused type
type _ = ai_chat_AiSdk5UiMessage;
