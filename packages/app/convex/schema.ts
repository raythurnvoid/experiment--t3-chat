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
	}).index("by_workspace_project_archived_lastMessageAt", ["workspaceId", "projectId", "archived", "lastMessageAt"]),

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
	}).index("by_workspace_project_thread", ["workspaceId", "projectId", "threadId"]),

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
		.index("by_workspace_project_user_page", ["workspaceId", "projectId", "userId", "pageId"])
		.index("by_user_page", ["userId", "pageId"]),

	pages_pending_edits_last_sequence_saved: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.string(),
		pageId: v.id("pages"),
		lastSequenceSaved: v.number(),
		updatedAt: v.number(),
	})
		.index("by_workspace_project_user_page", ["workspaceId", "projectId", "userId", "pageId"])
		.index("by_workspace_project_page_user", ["workspaceId", "projectId", "pageId", "userId"])
		.index("by_user_page", ["userId", "pageId"]),

	/**
	 * Tracks scheduled cleanup tasks for each pending edit row.
	 * The task is rescheduled whenever the row changes and becomes a no-op if the row
	 * was updated after the task was created.
	 */
	pages_pending_edits_cleanup_tasks: defineTable({
		pendingEditId: v.id("pages_pending_edits"),
		scheduledFunctionId: v.id("_scheduled_functions"),
		expectedUpdatedAt: v.number(),
	}).index("by_pendingEdit", ["pendingEditId"]),

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
		.index("by_workspace_project_parent_name", ["workspaceId", "projectId", "parentId", "name"])
		.index("by_workspace_project_parent_archiveOperation", [
			"workspaceId",
			"projectId",
			"parentId",
			"archiveOperationId",
		])
		.index("by_workspace_project_path_archiveOperation", ["workspaceId", "projectId", "path", "archiveOperationId"])
		.index("by_workspace_project_archiveOperation_path", ["workspaceId", "projectId", "archiveOperationId", "path"])
		.index("by_workspace_project_name", ["workspaceId", "projectId", "name"]),
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
	}).searchIndex("search_by_content", {
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
		startIndex: v.number(),
		endIndex: v.number(),
		lineStart: v.number(),
		lineEnd: v.number(),
		chunkFlags: v.number(),
	}).index("by_workspace_project_page_yjsSequence_chunkIndex", [
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
		.searchIndex("search_by_plainTextChunk", {
			searchField: "plainTextChunk",
			filterFields: ["workspaceId", "projectId"],
		})
		.index("by_workspace_project_page_yjsSequence_chunkIndex", [
			"workspaceId",
			"projectId",
			"pageId",
			"yjsSequence",
			"chunkIndex",
		])
		.index("by_markdownChunk", ["markdownChunkId"]),

	pages_yjs_snapshots: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		sequence: v.number(),
		snapshotUpdate: v.bytes(),
		createdBy: v.id("users"),
		updatedBy: v.string(),
		updatedAt: v.number(),
	}).index("by_workspace_project_page_sequence", ["workspaceId", "projectId", "pageId", "sequence"]),

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
	}).index("by_workspace_project_page_sequence", ["workspaceId", "projectId", "pageId", "sequence"]),

	pages_yjs_docs_last_sequences: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		lastSequence: v.number(),
	}).index("by_workspace_project_page", ["workspaceId", "projectId", "pageId"]),

	/**
	 * Internal table to track scheduled YJS snapshot updates.
	 */
	pages_yjs_snapshot_schedules: defineTable({
		pageId: v.id("pages"),
		scheduledFunctionId: v.id("_scheduled_functions"),
	}).index("by_page", ["pageId"]),

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
	}).index("by_workspace_project_page_archivedAt", ["workspaceId", "projectId", "pageId", "archivedAt"]),

	pages_snapshots_contents: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		pageSnapshotId: v.id("pages_snapshots"),
		content: v.string(),
		pageId: v.id("pages"),
	}).index("by_workspace_project_pageSnapshot", ["workspaceId", "projectId", "pageSnapshotId"]),
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
	}).index("by_workspace_project_thread", ["workspaceId", "projectId", "threadId"]),
	// #endregion chat messages

	// #region data deletion
	data_deletion_requests: defineTable({
		userId: v.id("users"),
		workspaceId: v.optional(v.id("workspaces")),
		projectId: v.optional(v.id("workspaces_projects")),
		scope: v.union(v.literal("project"), v.literal("workspace"), v.literal("user")),
	})
		.index("by_workspace_project", ["workspaceId", "projectId"])
		.index("by_user_scope", ["userId", "scope"])
		.index("by_workspace_scope", ["workspaceId", "scope"])
		.index("by_workspace_project_scope", ["workspaceId", "projectId", "scope"])
		.index("by_user", ["userId"]),
	// #endregion data deletion

	// #region access control
	access_control_role_assignments: defineTable({
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		userId: v.id("users"),
		role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_workspace_project_user_role", ["workspaceId", "projectId", "userId", "role"])
		.index("by_workspace_project_role_user", ["workspaceId", "projectId", "role", "userId"])
		.index("by_user_role_workspace_project", ["userId", "role", "workspaceId", "projectId"])
		.index("by_workspace_user_project_role", ["workspaceId", "userId", "projectId", "role"]),

	access_control_permission_grants: defineTable({
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		resourceKind: v.union(v.literal("workspace"), v.literal("project"), v.literal("page"), v.literal("thread")),
		resourceId: v.string(),
		principalKind: v.union(v.literal("role"), v.literal("user"), v.literal("public")),
		userId: v.optional(v.id("users")),
		role: v.optional(v.union(v.literal("owner"), v.literal("admin"), v.literal("member"))),
		permission: v.union(
			v.literal("workspace.update"),
			v.literal("workspace.delete"),
			v.literal("workspace.members.manage"),
			v.literal("workspace.roles.manage"),
			v.literal("project.create"),
			v.literal("project.update"),
			v.literal("project.delete"),
			v.literal("project.members.manage"),
			v.literal("asset.read"),
			v.literal("asset.write"),
			v.literal("asset.permissions.manage"),
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_workspace_user_project_resource_permission", [
			"workspaceId",
			"userId",
			"projectId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"permission",
		])
		.index("by_user_workspace_project_resource_permission", [
			"userId",
			"workspaceId",
			"projectId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"permission",
		])
		.index("by_workspace_project_resource_user_permission", [
			"workspaceId",
			"projectId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"userId",
			"permission",
		])
		.index("by_workspace_project_resource_role_permission", [
			"workspaceId",
			"projectId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"role",
			"permission",
		])
		.index("by_workspace_project_resource_public_permission", [
			"workspaceId",
			"projectId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"permission",
		]),
	// #endregion access control

	// #region workspaces
	workspaces: defineTable({
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		billingMode: v.union(v.literal("user"), v.literal("workspace_owner")),
		ownerUserId: v.id("users"),
		defaultProjectId: v.optional(v.id("workspaces_projects")),
		updatedAt: v.number(),
	})
		.index("by_name", ["name"])
		.index("by_ownerUser", ["ownerUserId"]),

	workspaces_projects: defineTable({
		workspaceId: v.id("workspaces"),
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		updatedAt: v.number(),
	}).index("by_workspace_default", ["workspaceId", "default"]),

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
		.index("by_project_user_active", ["projectId", "userId", "active"])
		.index("by_user_workspace_project_active", ["userId", "workspaceId", "projectId", "active"])
		.index("by_active_workspace_project_user", ["active", "workspaceId", "projectId", "userId"])
		.index("by_active_user_workspace_project", ["active", "userId", "workspaceId", "projectId"]),

	quotas: defineTable({
		quotaName: v.union(v.literal("extra_workspaces"), v.literal("extra_projects")),
		userId: v.optional(v.id("users")),
		workspaceId: v.optional(v.id("workspaces")),
		usedCount: v.number(),
		maxCount: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user_quotaName", ["userId", "quotaName"])
		.index("by_workspace_quotaName", ["workspaceId", "quotaName"]),
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
		.index("by_user", ["userId"])
		.index("by_polarCustomer_currentPeriodEnd", ["polarCustomerId", "subscription.currentPeriodEnd"])
		.index("by_lastSyncedAt", ["lastSyncedAt"]),

	/**
	 * Keep one billing-owned scheduler row per user so you can cancel or replace
	 * the current Workpool job without mixing Workpool ids into unrelated tables.
	 */
	billing_cancel_polar_subscription_jobs: defineTable({
		userId: v.id("users"),
		jobId: v.string(),
		updatedAt: v.number(),
	}).index("by_user", ["userId"]),
	// #endregion billing

	// #region users
	users_anon_tokens: defineTable({
		userId: v.id("users"),
		token: v.string(),
		updatedAt: v.number(),
	}).index("by_user", ["userId"]),

	users: defineTable({
		/** Clerk user ID, null for anonymous users */
		clerkUserId: v.union(v.string(), v.null()),
		anonymousAuthToken: v.optional(v.id("users_anon_tokens")),
		defaultWorkspaceId: v.optional(v.id("workspaces")),
		defaultProjectId: v.optional(v.id("workspaces_projects")),
		anagraphic: v.optional(v.id("users_anagraphics")),
		deletedAt: v.optional(v.number()),
	}).index("by_clerkUser", ["clerkUserId"]),

	users_anagraphics: defineTable({
		userId: v.id("users"),
		/** Display name, e.g. "Anonymous user <id>" for anonymous users */
		displayName: v.string(),
		avatarUrl: v.optional(v.string()),
		/** Normalized signed-in email kept for deleted-account recovery after Clerk deletion. */
		email: v.string(),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_email", ["email"]),

	clerk_webhook_receipts: defineTable({
		eventId: v.string(),
		eventType: v.string(),
		clerkUserId: v.optional(v.string()),
		receivedAt: v.number(),
	}).index("by_event", ["eventId"]),

	notifications: defineTable({
		userId: v.id("users"),
		kind: v.literal("workspace_project_invite"),
		read: v.boolean(),
		actorUserId: v.id("users"),
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_user_read", ["userId", "read"])
		.index("by_workspace_user_read", ["workspaceId", "userId", "read"])
		.index("by_workspace_project_user", ["workspaceId", "projectId", "userId"]),

	// #endregion users
});

export default app_convex_schema;

export { app_convex_schema };

// @ts-expect-error unused type
type _ = ai_chat_AiSdk5UiMessage;
