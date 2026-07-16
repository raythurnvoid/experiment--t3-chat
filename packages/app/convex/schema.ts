import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vWorkId } from "@convex-dev/workpool";
import type { ai_chat_AiSdk5UiMessage } from "../src/lib/ai-chat.ts";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";

const plugins_capability_validator = v.union(
	v.literal("plugin.secrets.read"),
	v.literal("outbound.fetch"),
	v.literal("workspace.files.read"),
);

const app_convex_schema = defineSchema({
	// #region ai
	ai_chat_threads: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),

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
	}).index("by_organization_workspace_archived_lastMessageAt", [
		"organizationId",
		"workspaceId",
		"archived",
		"lastMessageAt",
	]),

	ai_chat_threads_state: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		bashCwd: v.string(),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_thread", ["threadId"])
		.index("by_organization_workspace_thread", ["organizationId", "workspaceId", "threadId"]),

	/**
	 * Each doc should be compatible with {@link ai_chat_AiSdk5UiMessage}.
	 */
	ai_chat_threads_messages_aisdk_5: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),

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
	})
		.index("by_organization_workspace_thread", ["organizationId", "workspaceId", "threadId"])
		.index("by_organization_workspace_thread_clientGeneratedMessageId", [
			"organizationId",
			"workspaceId",
			"threadId",
			"clientGeneratedMessageId",
		]),

	ai_chat_files: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
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
		.index("by_organization_workspace_thread_path", ["organizationId", "workspaceId", "threadId", "path"]),

	ai_chat_files_content: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		fileNodeId: v.id("ai_chat_files"),
		bytes: v.bytes(),
	})
		.index("by_fileNode", ["fileNodeId"])
		.index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"])
		.index("by_thread_fileNode", ["threadId", "fileNodeId"]),

	// #endregion ai

	// #region public api
	public_api_grants: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.union(v.id("ai_chat_threads"), v.null()),
		principalKey: v.string(),
		tokenHash: v.string(),
		scopes: v.array(v.union(v.literal("files:list"), v.literal("files:read"))),
		pathPrefix: v.union(v.string(), v.null()),
		createdAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_user", ["userId"]),

	api_credentials: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		name: v.string(),
		keyId: v.string(),
		obfuscatedValue: v.string(),
		secretHash: v.string(),
		scopes: v.array(
			v.union(v.literal("files:list"), v.literal("files:read"), v.literal("files:write"), v.literal("files:download")),
		),
		createdAt: v.number(),
		revokedAt: v.union(v.number(), v.null()),
		lastUsedAt: v.union(v.number(), v.null()),
	})
		.index("by_keyId", ["keyId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_organization_workspace_user_revokedAt", ["organizationId", "workspaceId", "userId", "revokedAt"])
		.index("by_user", ["userId"]),

	/**
	 * In-flight `/api/v1/files/write` staging doc. Created with the asset docs before any R2 write,
	 * deleted atomically by the publish mutation. A surviving stage marks an unpublished write whose
	 * R2 objects and asset docs are safe to delete; publication deletes the stage first, so cleanup
	 * can never remove a published output. No `files_nodes` doc exists until publication.
	 */
	public_api_file_write_stages: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/** Authoring user: the credential owner, or the plugin run's actorUserId. */
		userId: v.id("users"),
		/** Present only for plugin_run writes; failure cleanup settles the linked started call. */
		runId: v.optional(v.id("plugins_event_runs")),
		callId: v.optional(v.id("plugins_event_run_calls")),
		/** Present only for user_api_key writes; publication revalidates the credential. */
		credentialId: v.optional(v.id("api_credentials")),
		/** Normalized absolute target path; parents are resolved again at publication. */
		path: v.string(),
		overwrite: v.union(v.literal("replace"), v.literal("fail")),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		/** Staged content. On publish it becomes the file's first version snapshot and the `node.assetId` target. */
		contentSnapshotAssetId: v.id("files_r2_assets"),
		/** Stages older than this are crashed writes; the cleanup cron deletes them and their assets. */
		expiresAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_expiresAt", ["expiresAt"])
		.index("by_run", ["runId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),
	// #endregion public api

	// #region value store
	value_store: defineTable({
		value: v.string(),
	}),
	// #endregion value store

	// #region files
	files_pending_updates: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.string(),
		fileNodeId: v.id("files_nodes"),
		baseYjsSequence: v.number(),
		baseYjsUpdate: v.bytes(),
		stagedBranchYjsUpdate: v.bytes(),
		unstagedBranchYjsUpdate: v.bytes(),
		size: v.number(),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_user_fileNode", ["organizationId", "workspaceId", "userId", "fileNodeId"])
		.index("by_user_fileNode", ["userId", "fileNodeId"]),

	files_pending_updates_last_sequence_saved: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.string(),
		fileNodeId: v.id("files_nodes"),
		lastSequenceSaved: v.number(),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_user_fileNode", ["organizationId", "workspaceId", "userId", "fileNodeId"])
		.index("by_organization_workspace_fileNode_user", ["organizationId", "workspaceId", "fileNodeId", "userId"])
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
	 * Indexed metadata docs for Markdown YAML frontmatter. Field docs support
	 * existence search for presence-only metadata, and value docs support primitive
	 * string, number, and boolean search. Arrays insert one value doc for each
	 * primitive item.
	 *
	 * Pending docs are user-scoped. Query code filters out other users' pending docs
	 * and hides stale committed docs for files the acting user is editing.
	 */
	files_metadata_docs: defineTable({
		organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
		workspaceId: v.union(
			v.id("organizations_workspaces"),
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		fileNodeId: v.id("files_nodes"),
		sourceKind: v.union(v.literal("committed"), v.literal("pending")),
		userId: v.optional(v.string()),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		yjsSequence: v.optional(v.number()),
		path: v.string(),
		treePath: v.string(),
		archiveOperationId: v.optional(v.string()),
		qualifiedField: v.string(),
		docKind: v.union(v.literal("field"), v.literal("value")),
		valueKind: v.optional(v.union(v.literal("string"), v.literal("number"), v.literal("boolean"))),
		stringValue: v.optional(v.string()),
		numberValue: v.optional(v.number()),
		booleanValue: v.optional(v.boolean()),
	})
		.index("by_organization_workspace_source_fileNode_qualifiedField", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"fileNodeId",
			"qualifiedField",
		])
		.index("by_organization_workspace_fileNode_qualifiedField", [
			"organizationId",
			"workspaceId",
			"fileNodeId",
			"qualifiedField",
		])
		.index("by_pendingUpdate_qualifiedField", ["pendingUpdateId", "qualifiedField"])
		.index("by_org_workspace_archive_docKind_qualifiedField_tree", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"docKind",
			"qualifiedField",
			"treePath",
		])
		.index("by_org_workspace_archive_docKind_qualifiedField_string_tree", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"docKind",
			"qualifiedField",
			"valueKind",
			"stringValue",
			"treePath",
		])
		.index("by_org_workspace_archive_docKind_qualifiedField_number_tree", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"docKind",
			"qualifiedField",
			"valueKind",
			"numberValue",
			"treePath",
		])
		.index("by_org_workspace_archive_docKind_qualifiedField_boolean_tree", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"docKind",
			"qualifiedField",
			"valueKind",
			"booleanValue",
			"treePath",
		]),

	files_nodes: defineTable({
		/** Organization ID extracted from roomId */
		organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
		/** Workspace ID extracted from roomId */
		workspaceId: v.union(
			v.id("organizations_workspaces"),
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
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
		/** Created by user ID. SYSTEM is the pseudo user ID for reserved global-organization content. */
		createdBy: v.union(v.id("users"), v.literal(users_SYSTEM_AUTHOR)),
		/** Updated by user ID. SYSTEM is the pseudo user ID for reserved global-organization content. */
		updatedBy: v.union(v.id("users"), v.literal(users_SYSTEM_AUTHOR)),
		/** timestamp in milliseconds when document was last updated */
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_parent_name_archiveOperation", [
			"organizationId",
			"workspaceId",
			"parentId",
			"name",
			"archiveOperationId",
		])
		.index("by_organization_workspace_parent_archiveOperation_name", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"name",
		])
		.index("by_organization_workspace_parent_archiveOperation_updatedAt", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"updatedAt",
		])
		.index("by_organization_workspace_path_archiveOperation", [
			"organizationId",
			"workspaceId",
			"path",
			"archiveOperationId",
		])
		.index("by_organization_workspace_treePath", ["organizationId", "workspaceId", "treePath"])
		.index("by_organization_workspace_archiveOperation_treePath", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"treePath",
		])
		.index("by_organization_workspace_archiveOperation_kind_treePath", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"kind",
			"treePath",
		])
		.index("by_organization_workspace_archive_kind_lowercaseExtension_tree", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"kind",
			"lowercaseExtension",
			"treePath",
		])
		.index("by_organization_workspace_archiveOperation_updatedAt", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"updatedAt",
		])
		.index("by_organization_workspace_asset", ["organizationId", "workspaceId", "assetId"])
		.searchIndex("search_path", {
			searchField: "path",
			filterFields: ["organizationId", "workspaceId", "archiveOperationId", "kind", "parentId"],
		}),

	/**
	 * Per-FILE content stats (`wc`), kept off the file node so updating them does not invalidate the
	 * file-tree / path-resolution queries that read the node. One row per file node; computed at
	 * materialization from the full markdown (exact). Byte size is NOT duplicated here — it lives on
	 * the content asset (`files_r2_assets.size`, per-version). Folders have no row.
	 */
	file_stats: defineTable({
		organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
		workspaceId: v.union(
			v.id("organizations_workspaces"),
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		fileNodeId: v.id("files_nodes"),
		/** Newline count (`wc -l`). -1 means the content cannot be processed (non-markdown/binary). */
		lineCount: v.number(),
		/** Whitespace-delimited word count (`wc -w`). -1 means cannot be processed. */
		wordCount: v.number(),
		/** Unicode code-point count (`wc -m`, not UTF-16 units). -1 means cannot be processed. */
		charCount: v.number(),
	}).index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"]),

	/**
	 * Exact Markdown chunk docs for committed Yjs materializations and per-user pending updates.
	 * Plain-text search docs point back here when callers need Markdown text, offsets, or line numbers.
	 */
	files_markdown_chunks: defineTable({
		organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
		workspaceId: v.union(
			v.id("organizations_workspaces"),
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		fileNodeId: v.id("files_nodes"),
		/** `committed` docs use `yjsSequence`; `pending` docs use `userId` and `pendingUpdateId`. */
		sourceKind: v.union(v.literal("committed"), v.literal("pending")),
		/** Present only on pending docs, so one user's unsaved edits stay invisible to other users. */
		userId: v.optional(v.string()),
		/** Present only on pending docs; used for pending reads and pending-update cleanup. */
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** Present only on committed docs; identifies which Yjs snapshot was materialized. */
		yjsSequence: v.optional(v.number()),
		chunkIndex: v.number(),
		markdownChunk: v.string(),
		/** Character offsets in the full Markdown content. */
		startIndex: v.number(),
		endIndex: v.number(),
		/** 1-based Markdown line range covered by this chunk. */
		lineStart: v.number(),
		lineEnd: v.number(),
		chunkFlags: v.number(),
	})
		.index("by_organization_workspace_source_fileNode_yjsSeq_chunk", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"fileNodeId",
			"yjsSequence",
			"chunkIndex",
		])
		.index("by_organization_workspace_source_fileNode_lineEnd_chunk", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"fileNodeId",
			"lineEnd",
			"chunkIndex",
		])
		.index("by_organization_workspace_source_fileNode_endIndex_chunk", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"fileNodeId",
			"endIndex",
			"chunkIndex",
		])
		.index("by_organization_workspace_fileNode_chunkIndex", [
			"organizationId",
			"workspaceId",
			"fileNodeId",
			"chunkIndex",
		])
		.index("by_pendingUpdate_chunkIndex", ["pendingUpdateId", "chunkIndex"])
		.index("by_pendingUpdate_lineEnd_chunkIndex", ["pendingUpdateId", "lineEnd", "chunkIndex"])
		.index("by_pendingUpdate_endIndex_chunkIndex", ["pendingUpdateId", "endIndex", "chunkIndex"]),

	/**
	 * Unified plain-text search docs. Pending docs are user-scoped; committed docs are global within
	 * the organization/workspace and suppressed at query time for files the acting user is editing.
	 * Search result display fields are duplicated here so full-text hits do not hydrate linked docs.
	 */
	files_plain_text_chunks: defineTable({
		organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
		workspaceId: v.union(
			v.id("organizations_workspaces"),
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		fileNodeId: v.id("files_nodes"),
		/** `committed` docs use `yjsSequence`; `pending` docs use `userId` and `pendingUpdateId`. */
		sourceKind: v.union(v.literal("committed"), v.literal("pending")),
		/** Present only on pending docs, so pending search results are scoped to their owner. */
		userId: v.optional(v.string()),
		/** Present only on pending docs; used for pending overlay and cleanup. */
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** Present only on committed docs; mirrors the linked Markdown chunk's materialized snapshot. */
		yjsSequence: v.optional(v.number()),
		/** Linked exact Markdown chunk for exact reads and integrity checks. */
		markdownChunkId: v.id("files_markdown_chunks"),
		/** Denormalized from files_nodes.path so scoped search can filter before pagination. */
		path: v.string(),
		/** Denormalized from files_nodes.archiveOperationId so archived chunks stay out of search pages. */
		archiveOperationId: v.optional(v.string()),
		chunkIndex: v.number(),
		plainTextChunk: v.string(),
		markdownChunk: v.string(),
		startIndex: v.number(),
		endIndex: v.number(),
		lineStart: v.number(),
		lineEnd: v.number(),
		chunkFlags: v.number(),
		hasChunkAbove: v.boolean(),
		hasChunkBelow: v.boolean(),
	})
		.searchIndex("search_by_plainTextChunk", {
			searchField: "plainTextChunk",
			filterFields: ["organizationId", "workspaceId", "archiveOperationId"],
		})
		.index("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"fileNodeId",
			"yjsSequence",
			"chunkIndex",
		])
		.index("by_organization_workspace_fileNode_chunkIndex", [
			"organizationId",
			"workspaceId",
			"fileNodeId",
			"chunkIndex",
		])
		.index("by_pendingUpdate_chunkIndex", ["pendingUpdateId", "chunkIndex"]),

	files_yjs_snapshots: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		sequence: v.number(),
		/** Current R2 asset for the compacted Yjs update. */
		assetId: v.id("files_r2_assets"),
		createdBy: v.id("users"),
		updatedBy: v.string(),
		updatedAt: v.number(),
	}).index("by_organization_workspace_fileNode_sequence", ["organizationId", "workspaceId", "fileNodeId", "sequence"]),

	files_yjs_updates: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
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
	}).index("by_organization_workspace_fileNode_sequence", ["organizationId", "workspaceId", "fileNodeId", "sequence"]),

	files_yjs_docs_last_sequences: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		lastSequence: v.number(),
	}).index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"]),

	files_content_materialization_jobs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		jobId: vWorkId,
		targetSequence: v.number(),
	})
		.index("by_fileNode", ["fileNodeId"])
		.index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"]),

	files_snapshots: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		assetId: v.id("files_r2_assets"),
		createdBy: v.id("users"),
		/**
		 * Use -1 for snapshots that were never archived, 0 for snapshots that were
		 * unarchived, and > 0 for the archive timestamp in milliseconds.
		 */
		archivedAt: v.number(),
	}).index("by_organization_workspace_fileNode_archivedAt", [
		"organizationId",
		"workspaceId",
		"fileNodeId",
		"archivedAt",
	]),

	files_r2_assets: defineTable({
		organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
		workspaceId: v.union(
			v.id("organizations_workspaces"),
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		kind: v.union(v.literal("upload"), v.literal("content"), v.literal("yjs_snapshot"), v.literal("content_snapshot")),
		r2Bucket: v.string(),
		/**
		 * Present only after the R2 object
		 * has been confirmed at this deterministic key.
		 **/
		r2Key: v.optional(v.string()),
		size: v.number(),
		etag: v.optional(v.string()),
		/**
		 * Content-processing state: undefined = not decided yet, a work id = processing in
		 * flight (cancellable), null = settled with nothing pending.
		 **/
		processingWorkId: v.optional(v.union(vWorkId, v.null())),
		/** Created by user ID. SYSTEM is the pseudo user ID for reserved global-organization content. */
		createdBy: v.union(v.id("users"), v.literal(users_SYSTEM_AUTHOR)),
		updatedAt: v.number(),
	}).index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * Operational status for read-only external mounts (v1: GitHub repo mirrors). This table's own
	 * scope is not a file scope, so no reserved-literal union applies. Content lives in immutable
	 * per-commit roots `/<name>/<commitSha>/...` in GLOBAL/GITHUB: sync ingests a fresh root, finalize
	 * flips `lastCommitSha`, and orphan roots are GC'd.
	 */
	github_mounts: defineTable({
		/** Mount name exposed as `/.mounts/<name>`. */
		name: v.string(),
		owner: v.string(),
		repo: v.string(),
		defaultBranch: v.union(v.string(), v.null()),
		/** Branch name to sync (v1: branch only). */
		ref: v.string(),
		/**
		 * Active-root pointer AND mount-visibility gate: the mount serves `/<name>/<lastCommitSha>/...`;
		 * null means not mounted (never synced, or wiped).
		 */
		lastCommitSha: v.union(v.string(), v.null()),
		lastTreeSha: v.union(v.string(), v.null()),
		lastSyncedAt: v.union(v.number(), v.null()),
		status: v.union(v.literal("idle"), v.literal("running"), v.literal("error")),
		startedAt: v.union(v.number(), v.null()),
		producerFinishedAt: v.union(v.number(), v.null()),
		finishedAt: v.union(v.number(), v.null()),
		lastError: v.union(v.string(), v.null()),
		enqueuedCount: v.optional(v.number()),
		completedCount: v.optional(v.number()),
		failedCount: v.optional(v.number()),
		skippedCount: v.optional(v.number()),
		compressedBytesRead: v.optional(v.number()),
		acceptedUncompressedBytes: v.optional(v.number()),
		/** App-generated id for the active sync run; stale async writes must match this before writing. */
		syncRunId: v.optional(v.string()),
		lockedAt: v.optional(v.number()),
		/**
		 * Commit SHA learned at metadata-fetch time for the active sync. Finalize promotes it to
		 * `lastCommitSha` on success or clears it on materialization failure.
		 */
		pendingCommitSha: v.optional(v.string()),
		/**
		 * Tree SHA learned at metadata-fetch time for the active sync. Kept on the mount doc so the
		 * last finishing worker can close the run without carrying per-file job metadata.
		 */
		pendingTreeSha: v.optional(v.string()),
	}).index("by_name", ["name"]),
	// #endregion files

	// #region plugins
	plugins_publisher_repositories: defineTable({
		ownerUserId: v.id("users"),
		repositoryUrl: v.string(),
		owner: v.string(),
		repo: v.string(),
		/** Last publish_version outcome after authorization; outlives the toast so first-publish rejections stay visible. */
		lastPublishAttempt: v.optional(
			v.object({
				at: v.number(),
				status: v.union(v.literal("succeeded"), v.literal("rejected"), v.literal("failed")),
				message: v.string(),
				commitSha: v.union(v.string(), v.null()),
			}),
		),
	})
		.index("by_ownerUser_repositoryUrl", ["ownerUserId", "repositoryUrl"])
		.index("by_repositoryUrl", ["repositoryUrl"]),

	/**
	 * Publisher secrets scoped to one claimed repository. Runtime resolution also matches the
	 * claim owner to the immutable version creator, so a later claimant cannot supply secrets.
	 */
	plugins_publisher_repository_secrets: defineTable({
		ownerUserId: v.id("users"),
		repositoryId: v.id("plugins_publisher_repositories"),
		name: v.string(),
		ciphertext: v.bytes(),
		nonce: v.bytes(),
		valuePreview: v.string(),
		updatedAt: v.number(),
		lastUsedAt: v.optional(v.number()),
	})
		.index("by_repository_name", ["repositoryId", "name"])
		.index("by_ownerUser", ["ownerUserId"]),

	plugins_versions: defineTable({
		name: v.string(),
		displayName: v.string(),
		version: v.string(),
		description: v.string(),
		reviewStatus: v.union(v.literal("pending"), v.literal("passed"), v.literal("rejected"), v.literal("flagged")),
		/**
		 * True only on the newest-created doc for this name:
		 * publish order stands in for version order.
		 **/
		isLatest: v.boolean(),
		artifactHash: v.string(),
		sourceRepositoryUrl: v.string(),
		sourceOwner: v.string(),
		sourceRepo: v.string(),
		sourceCommitSha: v.string(),
		manifestR2Key: v.string(),
		/**
		 * Pointer to the executable dist among `files`,
		 * plus Worker isolate config;
		 * null = no server-side code.
		 **/
		backendEntrypointFile: v.union(
			v.object({
				entry: v.string(),
				moduleName: v.string(),
				r2Key: v.string(),
				sha256: v.string(),
				compatibilityDate: v.string(),
				compatibilityFlags: v.array(v.string()),
			}),
			v.null(),
		),
		events: v.array(
			v.object({
				type: v.literal("files.upload.completed"),
				contentTypes: v.array(v.string()),
			}),
		),
		/** UI pages declared in the manifest; an empty array means this version has no frontend page. */
		pages: v.array(
			v.object({
				id: v.string(),
				title: v.string(),
				entry: v.string(),
				navItem: v.union(v.object({ label: v.string(), icon: v.union(v.string(), v.null()) }), v.null()),
			}),
		),
		capabilities: v.array(plugins_capability_validator),
		/**
		 * Exact https origins the plugin's code declares it calls; consented at install.
		 **/
		outboundOrigins: v.array(v.string()),
		files: v.array(
			v.object({
				path: v.string(),
				sha256: v.string(),
				bytes: v.number(),
				contentType: v.string(),
				r2Key: v.string(),
			}),
		),
		/** Publication visibility for the `/<pluginVersionId>/...` source tree in GLOBAL/PLUGINS. */
		sourceStatus: v.union(v.literal("preparing"), v.literal("failed"), v.literal("ready")),
		sourceLastError: v.union(v.string(), v.null()),
		createdBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_isLatest_name", ["isLatest", "name"])
		.index("by_name", ["name"])
		.index("by_name_reviewStatus_sourceStatus", ["name", "reviewStatus", "sourceStatus"])
		.index("by_name_sourceStatus", ["name", "sourceStatus"])
		.index("by_name_version", ["name", "version"])
		.index("by_name_version_artifactHash", ["name", "version", "artifactHash"])
		.index("by_sourceRepositoryUrl", ["sourceRepositoryUrl"])
		.index("by_sourceRepositoryUrl_createdBy_sourceStatus", ["sourceRepositoryUrl", "createdBy", "sourceStatus"]),

	plugins_version_reviews: defineTable({
		createdBy: v.id("users"),
		artifactHash: v.string(),
		pluginName: v.string(),
		version: v.string(),
		status: v.union(v.literal("passed"), v.literal("rejected"), v.literal("flagged")),
		mechanicalFindings: v.array(v.string()),
		aiFindings: v.array(v.string()),
		model: v.string(),
		/**
		 * Artifact hash of the previous passed
		 * version when the AI review was diff-based.
		 **/
		diffBaseArtifactHash: v.optional(v.string()),
		/**
		 * Time the first terminal verdict for this exact artifact was stored.
		 **/
		updatedAt: v.number(),
	})
		.index("by_artifactHash", ["artifactHash"])
		.index("by_createdBy_pluginName", ["createdBy", "pluginName"])
		.index("by_pluginName", ["pluginName"]),

	plugins_workspace_installations: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		pluginVersionId: v.id("plugins_versions"),
		pluginName: v.string(),
		status: v.union(v.literal("enabled"), v.literal("disabled")),
		acceptedCapabilities: v.array(plugins_capability_validator),
		capabilitiesAcceptedAt: v.number(),
		acceptedOutboundOrigins: v.array(v.string()),
		outboundOriginsAcceptedAt: v.number(),
		installedBy: v.id("users"),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_status_updatedAt", ["organizationId", "workspaceId", "status", "updatedAt"])
		.index("by_organization_workspace_status_pluginName", ["organizationId", "workspaceId", "status", "pluginName"])
		.index("by_organization_workspace_pluginName", ["organizationId", "workspaceId", "pluginName"])
		.index("by_organization_workspace_pluginVersion", ["organizationId", "workspaceId", "pluginVersionId"])
		.index("by_pluginVersion", ["pluginVersionId"]),

	plugins_workspace_installation_secrets: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		name: v.string(),
		ciphertext: v.bytes(),
		nonce: v.bytes(),
		valuePreview: v.string(),
		createdBy: v.id("users"),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_installation_name", ["installationId", "name"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	plugins_workspace_event_handlers: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		pluginName: v.string(),
		event: v.literal("files.upload.completed"),
		contentType: v.string(),
		/** The owning installation's `_creationTime`, denormalized for dispatch order in the scope index. */
		installationCreatedAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_scope_event_contentType_createdAt_name", [
			"organizationId",
			"workspaceId",
			"event",
			"contentType",
			"installationCreatedAt",
			"pluginName",
		])
		.index("by_installation", ["installationId"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	plugins_event_runs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		// The uploaded file the event fired for; plugin-written outputs are ordinary Markdown siblings.
		assetId: v.id("files_r2_assets"),
		fileNodeId: v.id("files_nodes"),
		actorUserId: v.id("users"),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		event: v.union(v.literal("files.upload.completed"), v.literal("files.run.requested")),
		eventId: v.string(),
		status: v.union(v.literal("queued"), v.literal("running"), v.literal("succeeded"), v.literal("failed")),
		workId: v.optional(vWorkId),
		apiTokenHash: v.optional(v.string()),
		apiTokenExpiresAt: v.optional(v.number()),
		acceptedCapabilities: v.array(plugins_capability_validator),
		expiresAt: v.number(),
		apiCallCount: v.number(),
		outputWriteCount: v.number(),
		errorMessage: v.union(v.string(), v.null()),
		runnerHttpStatus: v.optional(v.number()),
		runnerElapsedMs: v.optional(v.number()),
		pluginStatus: v.optional(v.number()),
		runnerOutputBytes: v.optional(v.number()),
		runnerOutputTruncated: v.optional(v.boolean()),
		updatedAt: v.number(),
		startedAt: v.optional(v.number()),
		finishedAt: v.optional(v.number()),
	})
		.index("by_asset_event_installation", ["assetId", "event", "installationId"])
		.index("by_organization_workspace_event_status_updatedAt", [
			"organizationId",
			"workspaceId",
			"event",
			"status",
			"updatedAt",
		])
		.index("by_organization_workspace_updatedAt", ["organizationId", "workspaceId", "updatedAt"])
		.index("by_work", ["workId"])
		.index("by_apiTokenHash", ["apiTokenHash"])
		.index("by_installation_updatedAt", ["installationId", "updatedAt"])
		.index("by_pluginVersion", ["pluginVersionId"])
		.index("by_status_expiresAt", ["status", "expiresAt"]),

	/**
	 * Per-run call ledger: one doc per consumed quota slot, whether a host API request or an
	 * outbound fetch. Stores only curated telemetry (route, status, byte counts, timing). Never
	 * store request or response bodies, bearer tokens, signed URLs, secret values, or raw
	 * provider/library errors.
	 */
	plugins_event_run_calls: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		runId: v.id("plugins_event_runs"),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		sequence: v.number(),
		kind: v.union(v.literal("api_request"), v.literal("outbound_fetch")),
		/** Public API route for `api_request`; the literal "outbound" for `outbound_fetch`. */
		route: v.string(),
		status: v.union(v.literal("started"), v.literal("succeeded"), v.literal("failed")),
		responseStatus: v.optional(v.number()),
		requestBytes: v.optional(v.number()),
		responseBytes: v.optional(v.number()),
		errorCode: v.optional(v.string()),
		errorMessage: v.union(v.string(), v.null()),
		startedAt: v.number(),
		finishedAt: v.optional(v.number()),
		elapsedMs: v.optional(v.number()),
		updatedAt: v.number(),
	})
		.index("by_run_sequence", ["runId", "sequence"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_installation", ["installationId"])
		.index("by_pluginVersion", ["pluginVersionId"]),

	/**
	 * Short-lived plugin-UI bearer sessions (`plu_` tokens, stored hashed). Every call rechecks
	 * that the installation is still enabled on the same version and that the minting user is
	 * still a member, so disabling, uninstalling, or upgrading revokes outstanding tokens on its
	 * own.
	 */
	plugins_ui_sessions: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		userId: v.id("users"),
		tokenHash: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_installation", ["installationId"])
		.index("by_user", ["userId"]),

	/**
	 * One doc per publish, created before the publish uploads anything: it lists the keys the
	 * publish is about to write, and a cleanup run is scheduled together with it. A successful
	 * publish removes it after registering the version. A doc still here past `cleanupAt` means
	 * the publish was interrupted: cleanup deletes its keys in bounded batches, keeping any key a
	 * registered `(name, version, artifactHash)` version owns.
	 */
	plugins_publish_artifact_cleanup_attempts: defineTable({
		repositoryId: v.id("plugins_publisher_repositories"),
		pluginName: v.string(),
		version: v.string(),
		artifactHash: v.string(),
		/** Fresh id embedded in every key, making one attempt's uploads impossible to share or delete from another. */
		uploadId: v.string(),
		/** At most 65 object keys: 64 manifest-capped files plus dist/bonobo.plugin.json. */
		r2Keys: v.array(v.string()),
		/** Cleanup never runs before this deadline, giving the owning publish action time to finish. */
		cleanupAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_cleanupAt", ["cleanupAt"])
		.index("by_pluginName", ["pluginName"]),

	// #endregion plugins

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
		/** Organization ID for multi-tenant scoping */
		organizationId: v.string(),
		/** Workspace ID for multi-tenant scoping */
		workspaceId: v.string(),
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
	}).index("by_organization_workspace_thread", ["organizationId", "workspaceId", "threadId"]),
	// #endregion chat messages

	// #region data deletion
	data_deletion_requests: defineTable({
		userId: v.id("users"),
		organizationId: v.optional(v.id("organizations")),
		workspaceId: v.optional(v.id("organizations_workspaces")),
		scope: v.union(v.literal("workspace"), v.literal("organization"), v.literal("user")),
		eligibleAt: v.number(),
	})
		.index("by_scope_eligibleAt", ["scope", "eligibleAt"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_user_scope", ["userId", "scope"])
		.index("by_organization_scope", ["organizationId", "scope"])
		.index("by_organization_workspace_scope", ["organizationId", "workspaceId", "scope"])
		.index("by_user", ["userId"]),
	// #endregion data deletion

	// #region access control
	access_control_role_assignments: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_user_role", ["organizationId", "workspaceId", "userId", "role"])
		.index("by_organization_workspace_role_user", ["organizationId", "workspaceId", "role", "userId"])
		.index("by_user_role_organization_workspace", ["userId", "role", "organizationId", "workspaceId"])
		.index("by_organization_user_workspace_role", ["organizationId", "userId", "workspaceId", "role"]),

	access_control_permission_grants: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		resourceKind: v.union(v.literal("organization"), v.literal("workspace"), v.literal("file"), v.literal("thread")),
		resourceId: v.string(),
		principalKind: v.union(v.literal("role"), v.literal("user"), v.literal("public")),
		userId: v.optional(v.id("users")),
		role: v.optional(v.union(v.literal("owner"), v.literal("admin"), v.literal("member"))),
		permission: v.union(
			v.literal("organization.update"),
			v.literal("organization.delete"),
			v.literal("organization.members.manage"),
			v.literal("organization.roles.manage"),
			v.literal("workspace.create"),
			v.literal("workspace.update"),
			v.literal("workspace.delete"),
			v.literal("workspace.members.manage"),
			v.literal("asset.read"),
			v.literal("asset.write"),
			v.literal("asset.permissions.manage"),
			v.literal("api.credentials.manage"),
			v.literal("workspace.plugins.manage"),
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_organization_user_workspace_resource_permission", [
			"organizationId",
			"userId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"permission",
		])
		.index("by_user_organization_workspace_resource_permission", [
			"userId",
			"organizationId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"permission",
		])
		.index("by_organization_workspace_resource_user_permission", [
			"organizationId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"userId",
			"permission",
		])
		.index("by_organization_workspace_resource_role_permission", [
			"organizationId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"role",
			"permission",
		])
		.index("by_organization_workspace_resource_public_permission", [
			"organizationId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"permission",
		]),
	// #endregion access control

	// #region organizations
	organizations: defineTable({
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		billingMode: v.union(v.literal("user"), v.literal("organization_owner")),
		ownerUserId: v.id("users"),
		defaultWorkspaceId: v.optional(v.id("organizations_workspaces")),
		updatedAt: v.number(),
	})
		.index("by_name", ["name"])
		.index("by_ownerUser", ["ownerUserId"]),

	organizations_workspaces: defineTable({
		organizationId: v.id("organizations"),
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		updatedAt: v.number(),
	}).index("by_organization_default", ["organizationId", "default"]),

	organizations_workspaces_users: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		updatedAt: v.optional(v.number()),
		/**
		 * `false` during account-deletion retention so memberships stay recoverable but non-effective.
		 * `true` for normal active membership.
		 */
		active: v.boolean(),
	})
		.index("by_workspace_user_active", ["workspaceId", "userId", "active"])
		.index("by_user_organization_workspace_active", ["userId", "organizationId", "workspaceId", "active"])
		.index("by_active_organization_workspace_user", ["active", "organizationId", "workspaceId", "userId"])
		.index("by_active_user_organization_workspace", ["active", "userId", "organizationId", "workspaceId"]),

	quotas: defineTable({
		quotaName: v.union(v.literal("extra_organizations"), v.literal("extra_workspaces")),
		userId: v.optional(v.id("users")),
		organizationId: v.optional(v.id("organizations")),
		usedCount: v.number(),
		maxCount: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user_quotaName", ["userId", "quotaName"])
		.index("by_organization_quotaName", ["organizationId", "quotaName"]),
	// #endregion organizations

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
		defaultOrganizationId: v.optional(v.id("organizations")),
		defaultWorkspaceId: v.optional(v.id("organizations_workspaces")),
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
		kind: v.literal("organization_workspace_invite"),
		read: v.boolean(),
		actorUserId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_user_read", ["userId", "read"])
		.index("by_organization_user_read", ["organizationId", "userId", "read"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"]),

	// #endregion users
});

export default app_convex_schema;

export { app_convex_schema };

// @ts-expect-error unused type
type _ = ai_chat_AiSdk5UiMessage;
