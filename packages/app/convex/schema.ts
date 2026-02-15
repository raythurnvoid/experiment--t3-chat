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
		clientGeneratedMessageId: v.string(),

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
	 * Keyed by user + page so all chat threads share a single pending edit per page.
	 */
	ai_chat_pending_edits: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.string(),
		pageId: v.id("pages"),
		baseContent: v.string(),
		modifiedContent: v.string(),
		updatedAt: v.number(),
	})
		.index("by_workspace_project_user", ["workspaceId", "projectId", "userId"])
		.index("by_workspace_project_user_page", ["workspaceId", "projectId", "userId", "pageId"]),

	/**
	 * Tracks scheduled cleanup tasks to remove a user's pending edits.
	 * One task per user; canceled on heartbeat, executed if user remains offline.
	 */
	ai_chat_pending_edits_cleanup_tasks: defineTable({
		userId: v.string(),
		scheduledFunctionId: v.id("_scheduled_functions"),
	}).index("by_userId", ["userId"]),
	// #endregion AI

	// #region Pages
	pages: defineTable({
		/** Workspace ID extracted from roomId */
		workspaceId: v.string(),
		/** Project ID extracted from roomId */
		projectId: v.string(),
		/** Materialized absolute path used for path resolution */
		path: v.string(),
		/** Display name used in path resolution */
		name: v.string(),
		/** ID of the markdown content for the page */
		markdownContentId: v.optional(v.id("pages_markdown_content")),
		/** ID of the last YJS sequence for the page */
		yjsLastSequenceId: v.optional(v.id("pages_yjs_docs_last_sequences")),
		/** ID of the last YJS sequence for the page */
		yjsSnapshotId: v.optional(v.id("pages_yjs_snapshots")),
		/** Document version - always 0 for now until versioning is implemented */
		version: v.number(),
		/** Whether document is archived */
		isArchived: v.boolean(),
		/** "root" for root items, otherwise parent page `_id` */
		parentId: v.union(v.id("pages"), v.literal("root")),
		/** Created by user ID */
		createdBy: v.id("users"),
		/** Updated by user ID */
		updatedBy: v.string(),
		/** timestamp in milliseconds when document was last updated */
		updatedAt: v.number(),
	})
		.index("by_workspaceId_projectId_parentId_and_name", ["workspaceId", "projectId", "parentId", "name"])
		.index("by_workspaceId_projectId_parentId_and_isArchived", ["workspaceId", "projectId", "parentId", "isArchived"])
		.index("by_workspaceId_projectId_path", ["workspaceId", "projectId", "path"])
		.index("by_workspaceId_projectId_and_name", ["workspaceId", "projectId", "name"]),
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

	// #region Chat Messages
	/**
	 * Chat messages table - a single table that represents both threads and messages.
	 * Root messages have `threadId = null`.
	 * Child messages have `threadId = rootId`.
	 *
	 * Any message can also be the root of a descendant thread by using that message id as
	 * the thread id for future children.
	 */
	chat_messages: defineTable({
		/** Workspace ID for multi-tenant scoping */
		workspaceId: v.string(),
		/** Project ID for multi-tenant scoping */
		projectId: v.string(),
		/**
		 * null → this row is a top-level root message.
		 * non-null → this row is a child message belonging to the message whose id is threadId.
		 */
		threadId: v.union(v.id("chat_messages"), v.null()),
		/**
		 * null for roots.
		 * For children: points to the parent/root message that this message directly replies to.
		 */
		parentId: v.union(v.id("chat_messages"), v.null()),
		/** Soft delete / hide flag, especially for root messages */
		isArchived: v.boolean(),
		/** User ID who created this message */
		createdBy: v.string(),
		/** Markdown content; produced from TipTap rich text on submit */
		content: v.string(),
	}).index("by_workspace_project_thread", ["workspaceId", "projectId", "threadId"]),
	// #endregion Chat Messages

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
