import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import type { ai_chat_AiSdk5UiMessage } from "../src/lib/ai-chat.ts";

const app_convex_schema = defineSchema({
	// #region ai
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
	}).index("byWorkspaceProjectArchivedLastMessageAt", ["workspaceId", "projectId", "archived", "lastMessageAt"]),

	/**
	 * Each doc should be compatible with {@link ai_chat_AiSdk5UiMessage}.
	 */
	ai_chat_threads_messages_aisdk_5: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),

		/**
		 * Root messages have `parentId: null`.
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
	}).index("byWorkspaceProjectThread", ["workspaceId", "projectId", "threadId"]),

	// #endregion ai

	// #region pages
	pages_pending_edits: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.string(),
		pageId: v.id("pages"),
		baseYjsSequence: v.number(),
		baseYjsUpdate: v.bytes(),
		stagedBranchYjsUpdate: v.bytes(),
		unstagedBranchYjsUpdate: v.bytes(),
		updatedAt: v.number(),
	})
		.index("byWorkspaceProjectUserPage", ["workspaceId", "projectId", "userId", "pageId"])
		.index("byUserPage", ["userId", "pageId"]),

	pages_pending_edits_last_sequence_saved: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.string(),
		pageId: v.id("pages"),
		lastSequenceSaved: v.number(),
		updatedAt: v.number(),
	})
		.index("byWorkspaceProjectUserPage", ["workspaceId", "projectId", "userId", "pageId"])
		.index("byWorkspaceProjectPageUser", ["workspaceId", "projectId", "pageId", "userId"])
		.index("byUserPage", ["userId", "pageId"]),

	/**
	 * Tracks scheduled cleanup tasks for each pending edit row.
	 * The task is rescheduled whenever the row changes and becomes a no-op if the row
	 * was updated after the task was created.
	 */
	pages_pending_edits_cleanup_tasks: defineTable({
		pendingEditId: v.id("pages_pending_edits"),
		scheduledFunctionId: v.id("_scheduled_functions"),
		expectedUpdatedAt: v.number(),
	}).index("byPendingEdit", ["pendingEditId"]),

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
		/** Archive operation UUID. Undefined means active */
		archiveOperationId: v.optional(v.string()),
		/** "root" for root items, otherwise parent page `_id` */
		parentId: v.union(v.id("pages"), v.literal("root")),
		/** Created by user ID */
		createdBy: v.id("users"),
		/** Updated by user ID */
		updatedBy: v.string(),
		/** timestamp in milliseconds when document was last updated */
		updatedAt: v.number(),
	})
		.index("byWorkspaceProjectParentName", ["workspaceId", "projectId", "parentId", "name"])
		.index("byWorkspaceProjectParentArchiveOperation", [
			"workspaceId",
			"projectId",
			"parentId",
			"archiveOperationId",
		])
		.index("byWorkspaceProjectPathArchiveOperation", [
			"workspaceId",
			"projectId",
			"path",
			"archiveOperationId",
		])
		.index("byWorkspaceProjectArchiveOperationPath", [
			"workspaceId",
			"projectId",
			"archiveOperationId",
			"path",
		])
		.index("byWorkspaceProjectName", ["workspaceId", "projectId", "name"]),
	/**
	 * Table to store markdown content for pages.
	 */
	pages_markdown_content: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		/** Markdown content */
		content: v.string(),
		/** Whether document is archived */
		isArchived: v.boolean(),
		/** YJS sequence to know the sync status */
		yjsSequence: v.number(),
		updatedAt: v.number(),
		updatedBy: v.string(),
	}).searchIndex("searchByContent", {
		searchField: "content",
		filterFields: ["workspaceId", "projectId", "isArchived"],
	}),

	pages_markdown_chunks: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		yjsSequence: v.number(),
		chunkIndex: v.number(),
		markdownChunk: v.string(),
		lineStart: v.number(),
		lineEnd: v.number(),
		chunkFlags: v.number(),
	}).index("byWorkspaceProjectPageYjsSequenceChunkIndex", [
		"workspaceId",
		"projectId",
		"pageId",
		"yjsSequence",
		"chunkIndex",
	]),

	pages_plain_text_chunks: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		yjsSequence: v.number(),
		chunkIndex: v.number(),
		plainTextChunk: v.string(),
		markdownChunkId: v.id("pages_markdown_chunks"),
	})
		.searchIndex("searchByPlainTextChunk", {
			searchField: "plainTextChunk",
			filterFields: ["workspaceId", "projectId"],
		})
		.index("byWorkspaceProjectPageYjsSequenceChunkIndex", [
			"workspaceId",
			"projectId",
			"pageId",
			"yjsSequence",
			"chunkIndex",
		])
		.index("byMarkdownChunk", ["markdownChunkId"]),

	pages_yjs_snapshots: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		sequence: v.number(),
		snapshotUpdate: v.bytes(),
		createdBy: v.id("users"),
		updatedBy: v.string(),
		updatedAt: v.number(),
	}).index("byWorkspaceProjectPageSequence", ["workspaceId", "projectId", "pageId", "sequence"]),

	pages_yjs_updates: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		sequence: v.number(),
		update: v.bytes(),
		origin: v.union(
			v.object({
				type: v.literal("USER_EDIT"),
				/**
				 * Even though sessions are destroyed when users disconnect, this
				 * is usedful to differentiate between local and remote edits.
				 */
				sessionId: v.string(),
			}),
			v.object({
				type: v.literal("USER_SNAPSHOT_RESTORE"),
				snapshotId: v.id("pages_snapshots"),
			}),
			v.object({
				type: v.literal("USER_AI_EDIT"),
			}),
		),
		createdBy: v.id("users"),
		createdAt: v.number(),
	}).index("byWorkspaceProjectPageSequence", ["workspaceId", "projectId", "pageId", "sequence"]),

	pages_yjs_docs_last_sequences: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		lastSequence: v.number(),
	}).index("byWorkspaceProjectPage", ["workspaceId", "projectId", "pageId"]),

	/**
	 * Internal table to track scheduled YJS snapshot updates.
	 */
	pages_yjs_snapshot_schedules: defineTable({
		pageId: v.id("pages"),
		scheduledFunctionId: v.id("_scheduled_functions"),
	}).index("byPage", ["pageId"]),

	pages_snapshots: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		createdBy: v.id("users"),
		/**
		 * Use -1 for snapshots that were never archived, 0 for snapshots that were
		 * unarchived, and > 0 for the archive timestamp in milliseconds.
		 */
		archivedAt: v.number(),
	}).index("byWorkspaceProjectPageArchivedAt", ["workspaceId", "projectId", "pageId", "archivedAt"]),

	pages_snapshots_contents: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageSnapshotId: v.id("pages_snapshots"),
		content: v.string(),
		pageId: v.id("pages"),
	}).index("byWorkspaceProjectPageSnapshot", ["workspaceId", "projectId", "pageSnapshotId"]),
	// #endregion pages

	// #region chat messages
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
	}).index("byWorkspaceProjectThread", ["workspaceId", "projectId", "threadId"]),
	// #endregion chat messages

	// #region data deletion
	data_deletion_requests: defineTable({
		userId: v.id("users"),
		workspaceId: v.optional(v.id("workspaces")),
		projectId: v.optional(v.id("workspaces_projects")),
		scope: v.union(v.literal("project"), v.literal("workspace"), v.literal("user")),
	})
		.index("byWorkspaceProject", ["workspaceId", "projectId"])
		.index("byUserScope", ["userId", "scope"])
		.index("byWorkspaceScope", ["workspaceId", "scope"])
		.index("byWorkspaceProjectScope", ["workspaceId", "projectId", "scope"])
		.index("byUser", ["userId"]),
	// #endregion data deletion

	// #region workspaces
	workspaces: defineTable({
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		ownerUserId: v.optional(v.id("users")),
		defaultProjectId: v.optional(v.id("workspaces_projects")),
		updatedAt: v.number(),
	}).index("byName", ["name"]),

	workspaces_projects: defineTable({
		workspaceId: v.id("workspaces"),
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		updatedAt: v.number(),
	}).index("byWorkspaceDefault", ["workspaceId", "default"]),

	workspaces_projects_users: defineTable({
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		userId: v.id("users"),
		updatedAt: v.optional(v.number()),
		/**
		 * `false` during account-deletion retention so memberships stay recoverable but non-effective.
		 * Omit or `true` for normal active membership. Backfilled to `true` via migration.
		 */
		active: v.optional(v.boolean()),
	})
		.index("byProjectUserActive", ["projectId", "userId", "active"])
		.index("byUserWorkspaceProjectActive", ["userId", "workspaceId", "projectId", "active"])
		.index("byActiveWorkspaceProjectUser", ["active", "workspaceId", "projectId", "userId"])
		.index("byActiveUserWorkspaceProject", ["active", "userId", "workspaceId", "projectId"]),

	limits_per_user: defineTable({
		userId: v.id("users"),
		limitName: v.union(v.literal("extra_workspaces")),
		usedCount: v.number(),
		maxCount: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
		lastReconciledAt: v.optional(v.number()),
	}).index("byUserLimitName", ["userId", "limitName"]),

	limits_per_workspace: defineTable({
		workspaceId: v.id("workspaces"),
		limitName: v.union(v.literal("extra_projects")),
		usedCount: v.number(),
		maxCount: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
		lastReconciledAt: v.optional(v.number()),
	}).index("byWorkspaceLimitName", ["workspaceId", "limitName"]),
	// #endregion workspaces

	// #region billing
	/**
	 * Cached Polar meter / spend snapshot per app user.
	 * Refreshed after usage ingest, periodically when stale, and on relevant Polar webhooks.
	 */
	billing_usage_snapshots: defineTable({
		userId: v.id("users"),
		polarCustomerId: v.union(v.string(), v.null()),
		subscription: v.union(
			v.object({
				id: v.union(v.string(), v.null()),
				productId: v.string(),
				currency: v.string(),
				currentPeriodStart: v.string(),
				currentPeriodEnd: v.string(),
			}),
			v.null(),
		),
		meter: v.union(
			v.object({
				id: v.union(v.string(), v.null()),
				consumedUnits: v.number(),
				creditedUnits: v.number(),
				balance: v.number(),
				amountDueCents: v.number(),
			}),
			v.null(),
		),
		lastSyncedAt: v.number(),
	})
		.index("byUser", ["userId"])
		.index("byPolarCustomerCurrentPeriodEnd", ["polarCustomerId", "subscription.currentPeriodEnd"])
		.index("byLastSyncedAt", ["lastSyncedAt"]),

	/**
	 * Keep one billing-owned scheduler row per user so you can cancel or replace
	 * the current Workpool job without mixing Workpool ids into unrelated tables.
	 */
	billing_cancel_polar_subscription_jobs: defineTable({
		userId: v.id("users"),
		jobId: v.string(),
		updatedAt: v.number(),
	}).index("byUser", ["userId"]),
	// #endregion billing

	// #region users
	users_anon_tokens: defineTable({
		userId: v.id("users"),
		token: v.string(),
		updatedAt: v.number(),
	}).index("byUser", ["userId"]),

	users: defineTable({
		/** Clerk user ID, null for anonymous users */
		clerkUserId: v.union(v.string(), v.null()),
		anonymousAuthToken: v.optional(v.id("users_anon_tokens")),
		defaultWorkspaceId: v.optional(v.id("workspaces")),
		defaultProjectId: v.optional(v.id("workspaces_projects")),
		anagraphic: v.optional(v.id("users_anagraphics")),
		deletedAt: v.optional(v.number()),
	}).index("byClerkUser", ["clerkUserId"]),

	users_anagraphics: defineTable({
		userId: v.id("users"),
		/** Display name, e.g. "Anonymous user <id>" for anonymous users */
		displayName: v.string(),
		avatarUrl: v.optional(v.string()),
		/** Normalized signed-in email kept for deleted-account recovery after Clerk deletion. */
		email: v.string(),
		updatedAt: v.number(),
	})
		.index("byUser", ["userId"])
		.index("byEmail", ["email"]),

	clerk_webhook_receipts: defineTable({
		eventId: v.string(),
		eventType: v.string(),
		clerkUserId: v.optional(v.string()),
		receivedAt: v.number(),
	}).index("byEvent", ["eventId"]),

	// #endregion users
});

export default app_convex_schema;

export { app_convex_schema };

// @ts-expect-error unused type
type _ = ai_chat_AiSdk5UiMessage;
