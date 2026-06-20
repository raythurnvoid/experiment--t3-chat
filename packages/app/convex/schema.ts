import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vWorkId } from "@convex-dev/workpool";
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
		stateId: v.union(v.id("ai_chat_threads_state"), v.null()),

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

	ai_chat_threads_state: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		threadId: v.id("ai_chat_threads"),
		bashCwd: v.string(),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_thread", ["threadId"])
		.index("by_workspace_project_thread", ["workspaceId", "projectId", "threadId"]),

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

	ai_chat_files: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		threadId: v.id("ai_chat_threads"),
		path: v.string(),
		kind: v.union(v.literal("file"), v.literal("directory"), v.literal("symlink")),
		/**
		 * POSIX mode bits from the scratch
		 * fs stat (e.g. 0o100644 file, 0o40755 directory),
		 * reapplied on hydrate
		 **/
		mode: v.number(),
		size: v.number(),
		/**
		 * Last-modified timestamp in milliseconds
		 * from the scratch fs stat, reapplied on hydrate
		 **/
		mtime: v.number(),
		/** Symlink target path,
		 * only present when kind is "symlink"
		 **/
		symlinkTargetPath: v.optional(v.string()),
	})
		.index("by_thread_path", ["threadId", "path"])
		.index("by_workspace_project_thread_path", ["workspaceId", "projectId", "threadId", "path"]),

	ai_chat_files_content: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		threadId: v.id("ai_chat_threads"),
		fileNodeId: v.id("ai_chat_files"),
		bytes: v.bytes(),
	})
		.index("by_fileNode", ["fileNodeId"])
		.index("by_workspace_project_fileNode", ["workspaceId", "projectId", "fileNodeId"])
		.index("by_thread_fileNode", ["threadId", "fileNodeId"]),

	// #endregion ai

	// #region value store
	value_store: defineTable({
		value: v.string(),
	}),
	// #endregion value store

	// #region files
	files_pending_updates: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.string(),
		fileNodeId: v.id("files_nodes"),
		baseYjsSequence: v.number(),
		baseYjsUpdate: v.bytes(),
		stagedBranchYjsUpdate: v.bytes(),
		unstagedBranchYjsUpdate: v.bytes(),
		size: v.number(),
		updatedAt: v.number(),
	})
		.index("by_workspace_project_user_fileNode", ["workspaceId", "projectId", "userId", "fileNodeId"])
		.index("by_user_fileNode", ["userId", "fileNodeId"]),

	files_pending_updates_last_sequence_saved: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.string(),
		fileNodeId: v.id("files_nodes"),
		lastSequenceSaved: v.number(),
		updatedAt: v.number(),
	})
		.index("by_workspace_project_user_fileNode", ["workspaceId", "projectId", "userId", "fileNodeId"])
		.index("by_workspace_project_fileNode_user", ["workspaceId", "projectId", "fileNodeId", "userId"])
		.index("by_user_fileNode", ["userId", "fileNodeId"]),

	/**
	 * Tracks scheduled cleanup tasks for each pending update row.
	 * The task is rescheduled whenever the row changes and becomes a no-op if the row
	 * was updated after the task was created.
	 */
	files_pending_updates_cleanup_tasks: defineTable({
		pendingUpdateId: v.id("files_pending_updates"),
		scheduledFunctionId: v.id("_scheduled_functions"),
		expectedUpdatedAt: v.number(),
	}).index("by_pendingUpdate", ["pendingUpdateId"]),

	/**
	 * Search-only materialization of each pending update's `unstaged` Markdown, chunked with the
	 * same chunker as committed content. Rows are replaced in the same mutation as every pending
	 * row write and deleted in the same mutation as every pending row delete, so no orphan chunks
	 * exist. Unlike committed chunks there is no denormalized path/archive scope: search joins
	 * `files_nodes` at read time because rename/move/archive flows never touch pending updates.
	 */
	files_pending_updates_chunks: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.string(),
		fileNodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
		chunkIndex: v.number(),
		markdownChunk: v.string(),
		plainTextChunk: v.string(),
		startIndex: v.number(),
		endIndex: v.number(),
		lineStart: v.number(),
		lineEnd: v.number(),
		chunkFlags: v.number(),
	})
		.searchIndex("search_by_plainTextChunk", {
			searchField: "plainTextChunk",
			filterFields: ["workspaceId", "projectId", "userId"],
		})
		.index("by_pendingUpdate_chunkIndex", ["pendingUpdateId", "chunkIndex"])
		.index("by_pendingUpdate_lineEnd_chunkIndex", ["pendingUpdateId", "lineEnd", "chunkIndex"])
		.index("by_pendingUpdate_endIndex_chunkIndex", ["pendingUpdateId", "endIndex", "chunkIndex"]),

	files_nodes: defineTable({
		/** Workspace ID extracted from roomId */
		workspaceId: v.string(),
		/** Project ID extracted from roomId */
		projectId: v.string(),
		/** Materialized absolute path used for path resolution */
		path: v.string(),
		/**
		 * Materialized subtree scan key used only for ordered tree range queries.
		 *
		 * Files and root use their canonical `path`. Non-root folders use `path + "/"`, so a range like
		 * `treePath >= "/docs/" && treePath < "/docs/\uffff"` returns `/docs` first
		 * followed by descendants, while excluding sibling-prefix paths such as `/docs-archive`.
		 */
		treePath: v.string(),
		/** Absolute path segment count; root is 0. */
		pathDepth: v.number(),
		/** Lowercase file extension without the dot; folders and extensionless files use null. */
		lowercaseExtension: v.union(v.string(), v.null()),
		/** Display name used in path resolution */
		name: v.string(),
		kind: v.union(v.literal("folder"), v.literal("file")),
		/**
		 * File content type. Folders leave this unset.
		 *
		 * Store lowercase media types with optional semicolon parameters, e.g. `text/markdown;charset=utf-8`.
		 */
		contentType: v.optional(v.string()),
		/**
		 * Back-reference to this file's `file_stats` row (wc counts), so callers holding the node can
		 * read stats by id without an index lookup. Optional because a node is created first and the
		 * stats row is linked back afterwards; folders never have one (files only).
		 */
		statsId: v.optional(v.id("file_stats")),
		/** ID of the last YJS sequence for the file */
		yjsLastSequenceId: v.optional(v.id("files_yjs_docs_last_sequences")),
		/** ID of the last YJS sequence for the file */
		yjsSnapshotId: v.optional(v.id("files_yjs_snapshots")),
		assetId: v.optional(v.id("files_r2_assets")),
		/** Archive Operation UUID. Undefined means active */
		archiveOperationId: v.optional(v.string()),
		/** "root" for root items, otherwise parent folder `_id` */
		parentId: v.union(v.id("files_nodes"), v.literal("root")),
		/** Created by user ID */
		createdBy: v.id("users"),
		/** Updated by user ID */
		updatedBy: v.id("users"),
		/** timestamp in milliseconds when document was last updated */
		updatedAt: v.number(),
	})
		.index("by_workspace_project_parent_name_archiveOperation", [
			"workspaceId",
			"projectId",
			"parentId",
			"name",
			"archiveOperationId",
		])
		.index("by_workspace_project_parent_archiveOperation_name", [
			"workspaceId",
			"projectId",
			"parentId",
			"archiveOperationId",
			"name",
		])
		.index("by_workspace_project_parent_archiveOperation_updatedAt", [
			"workspaceId",
			"projectId",
			"parentId",
			"archiveOperationId",
			"updatedAt",
		])
		.index("by_workspace_project_path_archiveOperation", ["workspaceId", "projectId", "path", "archiveOperationId"])
		.index("by_workspace_project_treePath", ["workspaceId", "projectId", "treePath"])
		.index("by_workspace_project_archiveOperation_treePath", [
			"workspaceId",
			"projectId",
			"archiveOperationId",
			"treePath",
		])
		.index("by_workspace_project_archiveOperation_kind_treePath", [
			"workspaceId",
			"projectId",
			"archiveOperationId",
			"kind",
			"treePath",
		])
		.index("by_workspace_project_archive_kind_lowercaseExtension_tree", [
			"workspaceId",
			"projectId",
			"archiveOperationId",
			"kind",
			"lowercaseExtension",
			"treePath",
		])
		.index("by_workspace_project_archiveOperation_updatedAt", [
			"workspaceId",
			"projectId",
			"archiveOperationId",
			"updatedAt",
		])
		.index("by_workspace_project_asset", ["workspaceId", "projectId", "assetId"])
		.searchIndex("search_path", {
			searchField: "path",
			filterFields: ["workspaceId", "projectId", "archiveOperationId", "kind", "parentId"],
		}),

	/**
	 * Per-FILE content stats (`wc`), kept off the file node so updating them does not invalidate the
	 * file-tree / path-resolution queries that read the node. One row per file node; computed at
	 * materialization from the full markdown (exact). Byte size is NOT duplicated here — it lives on
	 * the content asset (`files_r2_assets.size`, per-version). Folders have no row.
	 */
	file_stats: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		fileNodeId: v.id("files_nodes"),
		/** Newline count (`wc -l`). -1 means the content cannot be processed (non-markdown/binary). */
		lineCount: v.number(),
		/** Whitespace-delimited word count (`wc -w`). -1 means cannot be processed. */
		wordCount: v.number(),
		/** Unicode code-point count (`wc -m`, not UTF-16 units). -1 means cannot be processed. */
		charCount: v.number(),
	}).index("by_workspace_project_fileNode", ["workspaceId", "projectId", "fileNodeId"]),

	files_markdown_chunks: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		fileNodeId: v.id("files_nodes"),
		yjsSequence: v.number(),
		chunkIndex: v.number(),
		markdownChunk: v.string(),
		startIndex: v.number(),
		endIndex: v.number(),
		lineStart: v.number(),
		lineEnd: v.number(),
		chunkFlags: v.number(),
	})
		.index("by_workspace_project_fileNode_yjsSequence_chunkIndex", [
			"workspaceId",
			"projectId",
			"fileNodeId",
			"yjsSequence",
			"chunkIndex",
		])
		.index("by_workspace_project_fileNode_yjsSequence_lineEnd_chunkIndex", [
			"workspaceId",
			"projectId",
			"fileNodeId",
			"yjsSequence",
			"lineEnd",
			"chunkIndex",
		])
		.index("by_workspace_project_fileNode_yjsSequence_endIndex_chunkIndex", [
			"workspaceId",
			"projectId",
			"fileNodeId",
			"yjsSequence",
			"endIndex",
			"chunkIndex",
		]),

	files_plain_text_chunks: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		fileNodeId: v.id("files_nodes"),
		yjsSequence: v.number(),
		chunkIndex: v.number(),
		/** Denormalized from files_nodes.path so scoped search can filter before pagination. */
		path: v.string(),
		/** Denormalized from files_nodes.archiveOperationId so archived chunks stay out of search pages. */
		archiveOperationId: v.optional(v.string()),
		plainTextChunk: v.string(),
		markdownChunkId: v.id("files_markdown_chunks"),
	})
		.searchIndex("search_by_plainTextChunk", {
			searchField: "plainTextChunk",
			filterFields: ["workspaceId", "projectId", "archiveOperationId"],
		})
		.index("by_workspace_project_fileNode_yjsSequence_chunkIndex", [
			"workspaceId",
			"projectId",
			"fileNodeId",
			"yjsSequence",
			"chunkIndex",
		])
		.index("by_workspace_project_archive_path_chunkIndex", [
			"workspaceId",
			"projectId",
			"archiveOperationId",
			"path",
			"chunkIndex",
		])
		.index("by_markdownChunk", ["markdownChunkId"]),

	files_yjs_snapshots: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		fileNodeId: v.id("files_nodes"),
		sequence: v.number(),
		/** Current R2 asset for the compacted Yjs update. */
		assetId: v.id("files_r2_assets"),
		createdBy: v.id("users"),
		updatedBy: v.string(),
		updatedAt: v.number(),
	}).index("by_workspace_project_fileNode_sequence", ["workspaceId", "projectId", "fileNodeId", "sequence"]),

	files_yjs_updates: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		fileNodeId: v.id("files_nodes"),
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
				snapshotId: v.id("files_snapshots"),
			}),
			v.object({
				type: v.literal("USER_AI_EDIT"),
			}),
		),
		createdBy: v.id("users"),
		createdAt: v.number(),
	}).index("by_workspace_project_fileNode_sequence", ["workspaceId", "projectId", "fileNodeId", "sequence"]),

	files_yjs_docs_last_sequences: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		fileNodeId: v.id("files_nodes"),
		lastSequence: v.number(),
	}).index("by_workspace_project_fileNode", ["workspaceId", "projectId", "fileNodeId"]),

	files_content_materialization_jobs: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		fileNodeId: v.id("files_nodes"),
		jobId: vWorkId,
		targetSequence: v.number(),
	})
		.index("by_fileNode", ["fileNodeId"])
		.index("by_workspace_project_fileNode", ["workspaceId", "projectId", "fileNodeId"]),

	files_snapshots: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		fileNodeId: v.id("files_nodes"),
		assetId: v.id("files_r2_assets"),
		createdBy: v.id("users"),
		/**
		 * Use -1 for snapshots that were never archived, 0 for snapshots that were
		 * unarchived, and > 0 for the archive timestamp in milliseconds.
		 */
		archivedAt: v.number(),
	}).index("by_workspace_project_fileNode_archivedAt", ["workspaceId", "projectId", "fileNodeId", "archivedAt"]),

	files_r2_assets: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		kind: v.union(v.literal("upload"), v.literal("content"), v.literal("yjs_snapshot"), v.literal("content_snapshot")),
		r2Bucket: v.string(),
		/**
		 * Present only after the R2 object
		 * has been confirmed at this deterministic key.
		 **/
		r2Key: v.optional(v.string()),
		size: v.number(),
		etag: v.optional(v.string()),
		conversionWorkId: v.optional(v.union(vWorkId, v.null())),
		createdBy: v.id("users"),
		updatedAt: v.number(),
	}).index("by_workspace_project", ["workspaceId", "projectId"]),
	// #endregion files

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
		eligibleAt: v.number(),
	})
		.index("by_scope_eligibleAt", ["scope", "eligibleAt"])
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
		resourceKind: v.union(v.literal("workspace"), v.literal("project"), v.literal("file"), v.literal("thread")),
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
		 * `true` for normal active membership.
		 */
		active: v.boolean(),
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
		jobId: vWorkId,
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
