import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vWorkId } from "@convex-dev/workpool";
import type { ai_chat_UiMessage } from "../src/lib/ai-chat.ts";
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
	v.literal("workspace.files.write"),
	v.literal("workspace.files.create-read-only"),
	v.literal("workspace.files.own-write"),
	v.literal("workspace.files.own-access"),
	v.literal("plugin.data.read"),
	v.literal("plugin.data.write"),
	v.literal("plugin.data.user-write"),
	v.literal("plugin.backend.invoke"),
	v.literal("plugin.service.connect"),
	v.literal("ui.outbound.fetch"),
	v.literal("workspace.members.read"),
);

/**
 * The full list of permissions. Users build roles out of these, but can never add a new one.
 **/
const access_control_permission_validator = v.union(
	v.literal("organization.update"),
	v.literal("organization.members.manage"),
	v.literal("organization.roles.manage"),
	v.literal("organization.billing.manage"),
	v.literal("workspace.create"),
	v.literal("workspace.update"),
	v.literal("workspace.delete"),
	v.literal("workspace.members.manage"),
	v.literal("content.read"),
	v.literal("content.write"),
	v.literal("content.permissions.manage"),
	v.literal("workspace.plugins.manage"),
);

/**
 * A role you can give to someone: the name of a system role, or the id of a custom role.
 *
 * Owner cannot be given this way. The only source of ownership is `organizations.ownerUserId`, so
 * an owner has no role assignment doc.
 */
const access_control_role_ref_validator = v.union(
	v.literal("admin"),
	v.literal("member"),
	v.literal("viewer"),
	v.id("access_control_roles"),
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

		/**
		 * Keep this stored value. It does not track the AI SDK major version.
		 * The messages table name below has the same `aisdk_5` in it.
		 */
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
		/**
		 * Read cursor, timestamp in milliseconds.
		 * The thread is unread while `lastMessageAt > readAt`.
		 **/
		readAt: v.optional(v.number()),
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
	 * Each doc should be compatible with {@link ai_chat_UiMessage}.
	 *
	 * Keep this table name. It is stored data. It does not track the AI SDK major version.
	 * We removed the version from the TypeScript type names on purpose.
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
		 * One {@link ai_chat_UiMessage}.
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
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
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
			v.union(
				v.literal("files:list"),
				v.literal("files:read"),
				v.literal("files:write"),
				v.literal("files:download"),
				v.literal("plugin_data:read"),
				v.literal("plugin_data:write"),
			),
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
		/**
		 * Present only for plugin_service writes; publication revalidates the sealed grant.
		 */
		grantId: v.optional(v.id("plugin_service_grants")),
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
		/** Base sequence of the content proposal. Part of the canonical content group below. */
		baseYjsSequence: v.optional(v.number()),
		/**
		 * Canonical paged content group, set together or not at all (and only together with
		 * `baseYjsSequence`). Each id points at a sealed `files_pending_update_yjs_states` doc
		 * whose pages hold that branch's full state. Optional at the table level (move-only
		 * docs have no group); readers and writers require all five content fields together.
		 */
		baseLineageGeneration: v.optional(v.number()),
		baseStateId: v.optional(v.id("files_pending_update_yjs_states")),
		stagedStateId: v.optional(v.id("files_pending_update_yjs_states")),
		unstagedStateId: v.optional(v.id("files_pending_update_yjs_states")),
		/** Pending move/rename proposal. Ids are authoritative; `fromPath` is display/conflict metadata only. */
		pendingMove: v.optional(
			v.object({
				destParentId: v.union(v.id("files_nodes"), v.literal("root")),
				destName: v.string(),
				fromPath: v.string(),
				/**
				 * `mv -f` structural replacement: the active file node that owned the destination
				 * path at proposal time. Provenance metadata for the proposer's path overlay, which
				 * hides the replaced occupant from their reads. The panel's "Replaces" caption
				 * derives from live path occupancy instead. Accept re-validates and auto-replaces
				 * whichever file occupies the destination then, with or without this field; a
				 * folder occupant fails.
				 */
				replacesNodeId: v.optional(v.id("files_nodes")),
			}),
		),
		/**
		 * Pending delete proposal (`rm`): accepting archives the node (a folder archives its
		 * whole subtree, computed at accept time). The node id is authoritative; `fromPath` is
		 * display metadata only. Setting this clears `pendingMove` — a delete supersedes a move.
		 */
		pendingArchive: v.optional(
			v.object({
				fromPath: v.string(),
			}),
		),
		/** Copy provenance for the destination node of a pending copy (including `mv -f` replace-moves, which are stored as copies). */
		copiedFrom: v.optional(
			v.object({
				nodeId: v.id("files_nodes"),
				path: v.string(),
				/**
				 * A replace-move (`mv -f` between editable files) is stored as a copy — the source's
				 * content lands on the destination, which keeps its identity and history — plus this
				 * flag: accepting also archives the source, turning the copy into a move (mv = cp + rm).
				 */
				archivesSourceOnAccept: v.optional(v.boolean()),
			}),
		),
		/**
		 * Set when this proposal eagerly created the file node (write_file or cp onto a new path):
		 * the file shows as Added, and discard/expiry hard-deletes the node — but only when the
		 * safety gate passes: no content committed since the stamp, no rename/move of the node
		 * itself by another user, and no other user's pending update doc on it (an ancestor-folder
		 * move does not count). Otherwise only the doc is deleted and the node stays. Absent for
		 * proposals against pre-existing files, which must never hard-delete.
		 */
		eagerCreated: v.optional(
			v.object({
				/**
				 * The node's committed Yjs last sequence, captured in the same mutation that
				 * created the node (not at upsert time: the proposal upsert can land after a user
				 * already saved the brand-new file). Any save that commits content advances the
				 * node past this stamp, so the hard-delete safety check fails closed and the saved
				 * content survives. Immutable (never re-stamped on later patches/rebases).
				 */
				committedSequence: v.number(),
				/**
				 * Parent folders created for this file, starting with the folder closest to the file.
				 * Cleanup checks whether it can delete these folders after it deletes the file.
				 */
				createdAncestorIds: v.optional(v.array(v.id("files_nodes"))),
			}),
		),
		/**
		 * Chat threads that touched this proposal (contributor set, deduped). Agent writes append
		 * their thread id; client-driven writes preserve the array. Unset for client-only docs.
		 */
		threadIds: v.optional(v.array(v.id("ai_chat_threads"))),
		size: v.number(),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_user_fileNode", ["organizationId", "workspaceId", "userId", "fileNodeId"])
		.index("by_user_fileNode", ["userId", "fileNodeId"])
		.index("by_fileNode", ["fileNodeId"])
		.index("by_pendingMove_destParentId", ["pendingMove.destParentId"]),

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
	 * Tracks scheduled cleanup tasks for each pending update doc.
	 * The task is rescheduled whenever the doc changes and becomes a no-op if the doc
	 * was updated after the task was created.
	 */
	files_pending_updates_cleanup_tasks: defineTable({
		pendingUpdateId: v.id("files_pending_updates"),
		scheduledFunctionId: v.id("_scheduled_functions"),
		expectedUpdatedAt: v.number(),
	}).index("by_pendingUpdate", ["pendingUpdateId"]),

	/**
	 * Metadata for one paged pending-update Yjs state (one role: base, staged, or unstaged).
	 * The state bytes live in `files_pending_update_yjs_state_pages`; a full state can be larger
	 * than one Convex value, so it never travels or stores as a single value. The owner union says
	 * who is responsible for deleting the family: an active canonical state belongs to its pending
	 * update doc, a temporary state to an operation batch (expiry-swept), and a retired state to a
	 * durable cleanup task.
	 */
	files_pending_update_yjs_states: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.string(),
		fileNodeId: v.id("files_nodes"),
		owner: v.union(
			v.object({
				kind: v.literal("active"),
				pendingUpdateId: v.id("files_pending_updates"),
				role: v.union(v.literal("base"), v.literal("staged"), v.literal("unstaged")),
			}),
			v.object({
				kind: v.literal("temporary"),
				operationBatchId: v.id("files_pending_update_operation_batches"),
				phase: v.union(v.literal("input"), v.literal("output")),
				role: v.union(v.literal("base"), v.literal("staged"), v.literal("unstaged")),
				expiresAt: v.number(),
			}),
			v.object({
				kind: v.literal("retired"),
				cleanupTaskId: v.id("files_pending_update_state_cleanup_tasks"),
			}),
		),
		/** Lineage generation of the live document this state was built against. */
		lineageGeneration: v.number(),
		/** True once every page is written and the totals below describe the complete state. */
		sealed: v.boolean(),
		pageCount: v.number(),
		totalBytes: v.number(),
		/** Digest of the whole state bytes, so a reassembled state can be checked for torn pages. */
		digest: v.string(),
	})
		.index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"])
		.index("by_user", ["userId"])
		.index("by_owner_pendingUpdate", ["owner.pendingUpdateId"])
		.index("by_owner_operationBatch", ["owner.operationBatchId"])
		.index("by_owner_cleanupTask", ["owner.cleanupTaskId"])
		// Only the `temporary` owner variant has `expiresAt`, and Convex sorts docs without the
		// field BEFORE every number on this index. A TTL sweep must bound the range from below
		// (`q.gte("owner.expiresAt", 0)`), or it would also return every active and retired state.
		.index("by_owner_expiresAt", ["owner.expiresAt"]),

	/**
	 * One bounded page of a paged pending-update Yjs state. Pages are non-empty, at most
	 * `files_MAX_YJS_WIRE_BYTES`, and contiguous by `pageIndex` starting at 0.
	 */
	files_pending_update_yjs_state_pages: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		stateId: v.id("files_pending_update_yjs_states"),
		pageIndex: v.number(),
		bytes: v.bytes(),
	})
		.index("by_state_pageIndex", ["stateId", "pageIndex"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * Durable cleanup task for a retired pending-state family. The final commit of a rebase
	 * re-owns the previous states to a task doc instead of deleting their pages inline, and a
	 * bounded scheduled continuation drains the pages, states, and then the task itself.
	 */
	files_pending_update_state_cleanup_tasks: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		createdAt: v.number(),
	}).index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * One in-flight pending-state operation (upsert or rebase) for one user and file. Input and
	 * output states and text inputs hang off the batch. One active batch is allowed per
	 * user/node; a new batch-create by the same user takes over a batch idle past two minutes,
	 * and abandoned batches expire after 30 minutes so the sweeper deletes the family.
	 */
	files_pending_update_operation_batches: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.string(),
		fileNodeId: v.id("files_nodes"),
		expiresAt: v.number(),
		updatedAt: v.number(),
		/**
		 * When the batch last staged or sealed something. A new batch-create by the same user
		 * takes over a batch idle past the takeover window, so a crashed client does not lock
		 * the user out for the full TTL.
		 */
		lastActivityAt: v.number(),
	})
		.index("by_organization_workspace_user_fileNode", ["organizationId", "workspaceId", "userId", "fileNodeId"])
		.index("by_user", ["userId"])
		.index("by_expiresAt", ["expiresAt"]),

	/**
	 * One staged text value (staged or unstaged content) for a pending-state operation batch, so
	 * no registered call has to carry two large values at once. Consumed by the batch's commit;
	 * expired leftovers are swept with the batch.
	 */
	files_pending_update_text_inputs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.string(),
		fileNodeId: v.id("files_nodes"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		role: v.union(v.literal("staged"), v.literal("unstaged")),
		text: v.string(),
		expiresAt: v.number(),
	})
		.index("by_operationBatch", ["operationBatchId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_user", ["userId"])
		.index("by_expiresAt", ["expiresAt"]),

	/**
	 * Indexed metadata docs for a file. Field docs support existence search for presence-only
	 * metadata. Value docs support string, number, boolean, and maybe_date search. Arrays insert one
	 * value doc for each primitive item. Date-like strings also insert a maybe_date companion whose
	 * epoch-millisecond timestamp uses numberValue for range search.
	 *
	 * Two field prefixes write here, and `qualifiedField` says which one owns a doc:
	 * - `frontmatter.*` docs are extracted from a Markdown file's own YAML frontmatter, so a content
	 *   save deletes and rewrites them.
	 * - `metadata.*` docs are the file metadata a user or an agent wrote next to the file. They work
	 *   for every file kind, including binary uploads, and a content save never touches them.
	 *
	 * Pending docs are user-scoped. Query code filters out other users' pending docs
	 * and hides stale committed docs for files the acting user is editing. Only frontmatter docs are
	 * ever pending, because file metadata is written straight to committed.
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
		/**
		 * Where this key sits in the file's metadata map, counting from 0. The Properties modal is a
		 * YAML text editor, so reading the map back in index order would reorder the user's lines on
		 * every save. Set on `metadata.*` value docs only; frontmatter docs leave it unset.
		 */
		entryIndex: v.optional(v.number()),
		docKind: v.union(v.literal("field"), v.literal("value")),
		valueKind: v.optional(
			v.union(v.literal("string"), v.literal("number"), v.literal("boolean"), v.literal("maybe_date")),
		),
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
		/**
		 * Shape of this file's text: `rich_text` is the ProseMirror document Markdown files use,
		 * `plain_text` is a flat text document. Folders, stored blobs, and read-only mounts have no
		 * editable text and leave this unset.
		 *
		 * A collaborative file stores this beside its Yjs pointers, and the two are always written
		 * together. A non-collaborative file has no Yjs pointers but still stores this field,
		 * because the shape decides which chunker runs, whether frontmatter is indexed, which
		 * editor opens, and which renames are legal. So this field, not the Yjs pointers, is what
		 * marks a node as an editable text file.
		 */
		yjsRootKind: v.optional(v.union(v.literal("rich_text"), v.literal("plain_text"))),
		/**
		 * Set to `true` on an editable text file that the user turned collaboration OFF for. Such a
		 * file has no Yjs document at all: no snapshot, no sequence doc, no update log. Its text
		 * lives only in the committed chunks, and a save replaces the whole text.
		 *
		 * Absent means collaborative, so every file created before this field existed keeps its
		 * behaviour with no migration. The field and the Yjs pointers always change together in one
		 * mutation: turning collaboration off sets this and clears both pointers, turning it back on
		 * removes this and writes both pointers.
		 *
		 * Keep this field even though "no Yjs pointers" would be derivable. Several paths decide
		 * from the file name whether to build a Yjs document — a re-upload onto the file is the main
		 * one — and without a stored flag they would silently turn collaboration back on.
		 */
		nonCollaborative: v.optional(v.boolean()),
		/**
		 * The old Yjs lineage whose rows are still being deleted after collaboration is turned off.
		 * Turning collaboration back on waits for this marker to clear. This stops the old cleanup
		 * from deleting updates that belong to the fresh document, whose sequence starts at zero.
		 */
		collaborationCleanupYjsLastSequenceId: v.optional(v.id("files_yjs_docs_last_sequences")),
		assetId: v.optional(v.id("files_r2_assets")),
		/**
		 * Byte size of the last materialization that produced text over
		 * `files_MAX_TEXT_CONTENT_BYTES`. While set, the committed content stays at the last
		 * sequence that fit. Search and downloads serve that older text. Bash reads still rebuild
		 * the newest text from the Yjs log, so they and the committed readers disagree. Cleared by
		 * the next materialization that fits.
		 */
		contentTooLargeByteSize: v.optional(v.number()),
		/**
		 * Timestamp of the last materialization that refused because the Yjs document's shape did
		 * not match the node's `yjsRootKind`. While set, readers report a shape mismatch instead
		 * of content and the Yjs writers refuse more updates. Cleared by the next materialization
		 * that succeeds.
		 */
		contentShapeMismatchAt: v.optional(v.number()),
		/**
		 * Byte size of the last reconstructed Yjs state over
		 * `files_MAX_YJS_RECONSTRUCTED_STATE_BYTES`. While set, materialization does not advance,
		 * readers report the failure, and the Yjs writers refuse more updates until the operator
		 * repair rebuilds the state. Cleared by the next materialization that succeeds.
		 */
		contentYjsStateTooLargeByteSize: v.optional(v.number()),
		/**
		 * Frontmatter field count of the last materialization that refused because the count was
		 * over `files_metadata_MAX_FRONTMATTER_FIELDS`. While set, the committed content stays at
		 * the last sequence that fit. Cleared when the user reduces the metadata and a later
		 * materialization succeeds.
		 */
		contentFrontmatterTooLargeFieldCount: v.optional(v.number()),
		/**
		 * Frontmatter index-document count of the last materialization that refused because the
		 * count was over `files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS`. Same lifecycle as
		 * `contentFrontmatterTooLargeFieldCount`.
		 */
		contentFrontmatterTooLargeIndexDocumentCount: v.optional(v.number()),
		/** Archive Operation UUID. Undefined means active */
		archiveOperationId: v.optional(v.string()),
		/** "root" for root items, otherwise parent folder `_id` */
		parentId: v.union(v.id("files_nodes"), v.literal("root")),
		/**
		 * The nearest restricted folder above this node, or this node itself when it is the restricted
		 * one. When it is not set, the node uses normal workspace access.
		 *
		 * A node is restricted exactly when `restrictedScopeNodeId === _id`. Permission grants are
		 * stored only on that node, so a restricted folder and everything inside it share one pointer.
		 *
		 * `files_sharing.ts` sets and clears it; creates and moves copy it from the new parent, so it
		 * stays right without walking up the tree. See `files_nodes_db_cascade_restricted_scope`.
		 */
		restrictedScopeNodeId: v.optional(v.id("files_nodes")),
		/**
		 * The lock that makes this node read-only.
		 *
		 * Its own id means this node has a direct lock. Another id means a parent folder locked it.
		 * No value means the node is writable. Permissions are separate from this lock.
		 */
		readOnlyScopeNodeId: v.optional(v.id("files_nodes")),
		/**
		 * The exact service target that created this node's direct lock. Never returned to clients.
		 */
		readOnlyPluginServiceTargetId: v.optional(v.id("plugin_service_storage_targets")),
		/**
		 * The plugin whose own door created this node's direct lock. Only `plugin-access/set`,
		 * `plugin-archive`, and the same plugin's `archive-destination` can release it.
		 * Never returned to clients.
		 */
		readOnlyPluginName: v.optional(v.string()),
		/**
		 * Internal plugin-ownership stamp. Public file doors cannot set this field. Keep the plugin
		 * name, not an installation id, so frozen output can be adopted on reinstall. Any stamped
		 * node refuses the member sharing and lock doors: the host owns its reader list and locks,
		 * so members must not edit those grants by hand.
		 */
		pluginOwnerName: v.optional(v.string()),
		/**
		 * The plugin whose sealed service grant created this file through `/api/v1/files/write`.
		 * Only later service updates and the per-file archive read it as ownership proof; member
		 * sharing and lock code must ignore it, so the file stays a normal member-manageable file.
		 * Never returned to clients.
		 */
		pluginServiceWritePluginName: v.optional(v.string()),
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
	 * materialization from the full text (exact). Byte size is NOT duplicated here — it lives on
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
		/** Newline count (`wc -l`). -1 means the content cannot be processed (stored blob/binary, not editable text). */
		lineCount: v.number(),
		/** Whitespace-delimited word count (`wc -w`). -1 means cannot be processed. */
		wordCount: v.number(),
		/** Unicode code-point count (`wc -m`, not UTF-16 units). -1 means cannot be processed. */
		charCount: v.number(),
	}).index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"]),

	/** Exact text chunks for committed Yjs materializations and per-user pending updates. */
	files_text_chunks: defineTable({
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
		textChunk: v.string(),
		/** Character offsets in the full text content. */
		startIndex: v.number(),
		endIndex: v.number(),
		/** 1-based text line range covered by this chunk. */
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
		/** Present only on committed docs; mirrors the linked text chunk's materialized snapshot. */
		yjsSequence: v.optional(v.number()),
		/** Linked exact text chunk for exact reads and integrity checks. */
		textChunkId: v.id("files_text_chunks"),
		/** Denormalized from files_nodes.path so scoped search can filter before pagination. */
		path: v.string(),
		/** Denormalized from files_nodes.archiveOperationId so archived chunks stay out of search pages. */
		archiveOperationId: v.optional(v.string()),
		chunkIndex: v.number(),
		plainTextChunk: v.string(),
		textChunk: v.string(),
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
	})
		.index("by_organization_workspace_fileNode_sequence", ["organizationId", "workspaceId", "fileNodeId", "sequence"])
		.index("by_asset", ["assetId"]),

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
		/** Count of not-yet-materialized `files_yjs_updates` docs for this file. */
		unmaterializedUpdateCount: v.number(),
		/**
		 * Total `update` bytes of not-yet-materialized `files_yjs_updates` docs for this file.
		 * Same lifecycle as `unmaterializedUpdateCount`.
		 */
		unmaterializedUpdateBytes: v.number(),
		/**
		 * Bumped by the operator Yjs repair when it replaces the document's history. Pending
		 * proposals record the generation they were built against, so a repair makes them visibly
		 * stale instead of merging onto a rebuilt document.
		 */
		lineageGeneration: v.number(),
	}).index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"]),

	/**
	 * One server-built Yjs update staged ahead of its commit mutation (pending Accept, public
	 * fill, snapshot restore), so the commit call carries only ids and one bounded text value.
	 * Consumed on commit; abandoned stages expire after 30 minutes and the sweeper deletes them.
	 */
	files_yjs_trusted_update_stages: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		fileNodeId: v.id("files_nodes"),
		kind: v.union(v.literal("pending_accept"), v.literal("public_fill"), v.literal("snapshot_restore")),
		update: v.bytes(),
		expiresAt: v.number(),
	})
		.index("by_organization_workspace_user_fileNode", ["organizationId", "workspaceId", "userId", "fileNodeId"])
		.index("by_user", ["userId"])
		.index("by_expiresAt", ["expiresAt"]),

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
	})
		.index("by_organization_workspace_fileNode_archivedAt", [
			"organizationId",
			"workspaceId",
			"fileNodeId",
			"archivedAt",
		])
		.index("by_asset", ["assetId"]),

	files_r2_assets: defineTable({
		organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
		workspaceId: v.union(
			v.id("organizations_workspaces"),
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		/**
		 * `generated_image` is a picture the chat agent drew. It belongs to a chat message, not to a
		 * file node, so nothing in the file tree points at it.
		 */
		kind: v.union(
			v.literal("upload"),
			v.literal("content"),
			v.literal("yjs_snapshot"),
			v.literal("content_snapshot"),
			v.literal("generated_image"),
		),
		r2Bucket: v.string(),
		/**
		 * The final R2 key. It is set after R2 confirms that the file exists there.
		 **/
		r2Key: v.optional(v.string()),
		size: v.number(),
		etag: v.optional(v.string()),
		/**
		 * Upload processing state. Undefined means not started. A work id means running.
		 * Null means finished.
		 **/
		processingWorkId: v.optional(v.union(vWorkId, v.null())),
		/**
		 * When to check an unfinished asset again. New assets get a 24-hour deadline. Clear it only
		 * after a node or snapshot uses the R2 file, or cleanup confirms the file is deleted. The
		 * hourly cleanup in r2.ts checks assets after this time.
		 **/
		unfinalizedExpiresAt: v.optional(v.number()),
		/**
		 * When the signed upload URL stops working. Cleanup uses this time because the URL can
		 * create the temporary R2 file again until it expires.
		 */
		uploadUrlExpiresAt: v.optional(v.number()),
		/**
		 * The temporary R2 key used by the signed upload URL. After the upload, the backend copies
		 * this file to the final `r2Key`. Reusing the URL can only change this temporary file.
		 */
		uploadStagingR2Key: v.optional(v.string()),
		/** Created by user ID. SYSTEM is the pseudo user ID for reserved global-organization content. */
		createdBy: v.union(v.id("users"), v.literal(users_SYSTEM_AUTHOR)),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_unfinalizedExpiresAt", ["unfinalizedExpiresAt"]),

	/**
	 * Each doc asks the scheduled worker to delete one exact R2 key. The worker retries until R2
	 * confirms deletion. Increase `generation` when new bytes may have reached the key. A delete
	 * started for an older generation cannot remove the newer job.
	 */
	files_r2_object_deletion_jobs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		r2Key: v.string(),
		reason: v.union(
			v.literal("failed_create"),
			v.literal("read_only_create"),
			v.literal("upload_staging"),
			v.literal("read_only_stage"),
			v.literal("read_only_snapshot_restore"),
			v.literal("read_only_yjs_repair"),
			v.literal("untracked_asset_event"),
		),
		assetId: v.optional(v.id("files_r2_assets")),
		generation: v.number(),
		lastR2EventId: v.optional(v.string()),
		/**
		 * The last time another upload may reach this key. Before this time, keep the job after a
		 * successful delete and delete again later. Leave it empty when no later upload can arrive.
		 */
		putMayArriveUntil: v.optional(v.number()),
		attempts: v.number(),
		nextAttemptAt: v.number(),
	})
		.index("by_r2_key", ["r2Key"])
		.index("by_next_attempt_at", ["nextAttemptAt"]),

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
				/**
				 * Plugin read from the validated manifest. Null when publishing failed before that point.
				 */
				pluginName: v.union(v.string(), v.null()),
				status: v.union(v.literal("succeeded"), v.literal("rejected"), v.literal("flagged"), v.literal("failed")),
				message: v.string(),
				commitSha: v.union(v.string(), v.null()),
				/**
				 * The build this attempt was about. Null before the manifest could be read and hashed.
				 */
				artifactHash: v.union(v.string(), v.null()),
				/**
				 * The review that decided this attempt. Set only when a review reached a verdict, so an
				 * operational failure — provider, budget, or source-fetch — leaves it null and cannot be
				 * mistaken for a verdict nobody produced.
				 */
				reviewId: v.union(v.id("plugins_version_reviews"), v.null()),
			}),
		),
	})
		.index("by_ownerUser_repositoryUrl", ["ownerUserId", "repositoryUrl"])
		.index("by_repositoryUrl", ["repositoryUrl"])
		.index("by_lastPublishAttempt_pluginName", ["lastPublishAttempt.pluginName"])
		.index("by_lastPublishAttempt_reviewId", ["lastPublishAttempt.reviewId"]),

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

	/**
	 * One doc per plugin name that registered an outside service for the service-grant exchange.
	 * The host generates the `pse_` secret and stores only its hash; rotating writes a new hash and
	 * the old secret stops working immediately. The registered scopes are the exchange authority —
	 * the manifest's `service` block is only consent copy.
	 */
	plugins_service_registrations: defineTable({
		pluginName: v.string(),
		exchangeSecretHash: v.string(),
		scopes: v.array(
			v.union(v.literal("plugin_data:read"), v.literal("plugin_data:write"), v.literal("files:write")),
		),
		createdBy: v.id("users"),
		updatedAt: v.number(),
	}).index("by_pluginName", ["pluginName"]),

	plugins_versions: defineTable({
		name: v.string(),
		displayName: v.string(),
		version: v.string(),
		description: v.string(),
		reviewStatus: v.union(v.literal("pending"), v.literal("passed"), v.literal("rejected"), v.literal("flagged")),
		/**
		 * The review that decided this version. Null only for a version that has not reached review.
		 */
		reviewId: v.union(v.id("plugins_version_reviews"), v.null()),
		/**
		 * True only on the version that most recently became ready for this name.
		 * Ready order stands in for version order.
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
		/**
		 * The plugin-owned YAML editor shown for each installation. Null means the plugin has no settings.
		 */
		configuration: v.union(
			v.object({
				description: v.string(),
				defaultYaml: v.string(),
			}),
			v.null(),
		),
		/**
		 * Secret names the manifest declares, so the details page can report which required
		 * secrets are still missing. Optional because versions published before this field
		 * exist without it; read as `version.secrets ?? []`.
		 */
		secrets: v.optional(
			v.array(
				v.object({
					name: v.string(),
					description: v.string(),
					optional: v.boolean(),
				}),
			),
		),
		events: v.array(
			v.object({
				type: v.union(v.literal("files.upload.completed"), v.literal("users.account.deleted")),
				// Empty for an event that carries no file. The manifest validator decides which events
				// may leave it empty.
				contentTypes: v.array(v.string()),
				filters: v.array(
					v.object({
						field: v.literal("source.path"),
						operator: v.literal("pathIsUnderAny"),
						configurationPath: v.array(v.string()),
					}),
				),
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
		/** File views declared in the manifest; an empty array means this version opens no file content types. */
		fileViews: v.array(
			v.object({
				id: v.string(),
				title: v.string(),
				entry: v.string(),
				contentTypes: v.array(v.string()),
			}),
		),
		/**
		 * Backend endpoints the invoke door may run, normalized to `[]` when the manifest declares
		 * none. `serialization` is normalized to `"installation"` when the manifest omits it.
		 *
		 * Every stored version has been backfilled. The field stays optional on purpose: a reader
		 * treats an absent value as "no endpoint restriction", which is the safe direction, and
		 * tightening the validator would reject any version written by an older publish path.
		 */
		endpoints: v.optional(
			v.array(
				v.object({
					id: v.string(),
					path: v.string(),
					serialization: v.union(v.literal("installation"), v.literal("caller-key")),
				}),
			),
		),
		/**
		 * The manifest's service consent copy, or null when the manifest declares no service block.
		 * The service-registration row is the exchange authority; this list is display-only.
		 *
		 * Every stored version has been backfilled. The field stays optional on purpose: it grants
		 * nothing, so an absent value is only a missing display string.
		 */
		serviceScopes: v.optional(
			v.union(
				v.array(v.union(v.literal("plugin_data:read"), v.literal("plugin_data:write"), v.literal("files:write"))),
				v.null(),
			),
		),
		/**
		 * The collections a member-identity writer may write. Null means the manifest declared no
		 * list, so every collection stays user-writable; `[]` means nothing is.
		 *
		 * Every stored version has been backfilled. The field stays optional on purpose: readers
		 * treat absent the same as null, which is the documented "no list declared" case.
		 */
		userWritableCollections: v.optional(v.union(v.array(v.string()), v.null())),
		capabilities: v.array(plugins_capability_validator),
		/**
		 * Exact https origins the plugin's code declares it calls; consented at install.
		 **/
		outboundOrigins: v.array(v.string()),
		/**
		 * Exact https origins the plugin's pages and file views may call from the browser; consented at install.
		 *
		 * The asset response builds its `connect-src` from this list, and an asset request carries only
		 * a plugin version and a path. So this has to live on the immutable version: the response cannot
		 * know which installation is looking at it.
		 */
		uiOutboundOrigins: v.array(v.string()),
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
		.index("by_name_sourceStatus_updatedAt", ["name", "sourceStatus", "updatedAt"])
		.index("by_name_version", ["name", "version"])
		.index("by_name_version_artifactHash", ["name", "version", "artifactHash"])
		.index("by_reviewId", ["reviewId"])
		.index("by_reviewId_sourceStatus", ["reviewId", "sourceStatus"])
		.index("by_sourceRepositoryUrl", ["sourceRepositoryUrl"])
		.index("by_sourceRepositoryUrl_createdBy_sourceStatus", ["sourceRepositoryUrl", "createdBy", "sourceStatus"])
		.index("by_sourceRepositoryUrl_createdBy_sourceStatus_updatedAt", [
			"sourceRepositoryUrl",
			"createdBy",
			"sourceStatus",
			"updatedAt",
		]),

	plugins_version_reviews: defineTable({
		/**
		 * Null after the creator is deleted while a registered version still points at this review.
		 */
		createdBy: v.union(v.id("users"), v.null()),
		/**
		 * The exact build this verdict was first produced for. Kept for release traceability only. It is
		 * no longer what the cache is keyed on, because it changes with the version number, and a
		 * release that only bumps the version reviews identical content.
		 */
		artifactHash: v.string(),
		/**
		 * What was actually reviewed: every security-relevant manifest field and file hash, with the
		 * version number removed. Two releases of the same content share this value.
		 */
		reviewSubjectHash: v.string(),
		/**
		 * Which review policy produced this verdict. Bump `plugins_REVIEW_POLICY_VERSION` whenever the
		 * prompts, the mechanical severities, the model or tool semantics, the file classifier, or the
		 * required coverage change. Old verdicts then stop being reused instead of silently authorizing
		 * a publish under a policy that no longer exists.
		 */
		reviewPolicyVersion: v.string(),
		pluginName: v.string(),
		version: v.string(),
		status: v.union(v.literal("passed"), v.literal("rejected"), v.literal("flagged")),
		/**
		 * Mechanical findings that rejected this version. A non-empty array means `status: "rejected"`.
		 */
		mechanicalFindings: v.array(v.string()),
		/**
		 * Mechanical findings the publisher should see that block nothing. A normal vendored or
		 * bundled dependency trips these, so rejecting on them would fail plugins nobody can fix.
		 */
		mechanicalAdvisoryFindings: v.array(v.string()),
		aiFindings: v.array(v.string()),
		/**
		 * Which file the reviewer held responsible for each subject the manifest declares. Empty when no
		 * model ran, such as a mechanical rejection or an artifact with no reviewable text.
		 *
		 * A review only passes when every typed capability or origin subject has an entry naming a file
		 * and exact byte range the reviewer really read. Entries for secret reads and dynamic loads are
		 * kept too; the host cannot require them because it learns about them only from plugin code.
		 */
		capabilityMap: v.array(
			v.object({
				subject: v.string(),
				path: v.string(),
				evidence: v.string(),
				startByte: v.number(),
				endByte: v.number(),
			}),
		),
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
		.index("by_reviewSubjectHash_reviewPolicyVersion", ["reviewSubjectHash", "reviewPolicyVersion"])
		.index("by_createdBy_pluginName", ["createdBy", "pluginName"])
		.index("by_pluginName", ["pluginName"]),

	/**
	 * Durable stop sign for one plugin name while its registry docs drain in bounded passes.
	 * A failed or lost delete pass leaves the fence in place so publishing and installs stay closed.
	 */
	plugins_registry_deletion_fences: defineTable({
		pluginName: v.string(),
		createdAt: v.number(),
	}).index("by_pluginName", ["pluginName"]),

	plugins_workspace_installations: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		pluginVersionId: v.id("plugins_versions"),
		pluginName: v.string(),
		status: v.union(v.literal("enabled"), v.literal("disabled")),
		/**
		 * User-edited installation settings shown in the plugin configuration editor.
		 * Null means the installed version does not declare configuration.
		 */
		configurationYaml: v.union(v.string(), v.null()),
		acceptedCapabilities: v.array(plugins_capability_validator),
		capabilitiesAcceptedAt: v.number(),
		acceptedOutboundOrigins: v.array(v.string()),
		outboundOriginsAcceptedAt: v.number(),
		/**
		 * The page origins this workspace agreed to. Nothing reads this to decide a request: the page's
		 * `connect-src` comes from the version. It is the record of what the install dialog showed, so
		 * an audit after an upgrade can still say what the workspace agreed to before it.
		 */
		acceptedUiOutboundOrigins: v.array(v.string()),
		installedBy: v.id("users"),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_status_updatedAt", ["organizationId", "workspaceId", "status", "updatedAt"])
		.index("by_organization_workspace_status_pluginName", ["organizationId", "workspaceId", "status", "pluginName"])
		.index("by_organization_workspace_pluginName", ["organizationId", "workspaceId", "pluginName"])
		.index("by_organization_workspace_pluginVersion", ["organizationId", "workspaceId", "pluginVersionId"])
		.index("by_pluginVersion", ["pluginVersionId"])
		.index("by_pluginName_status", ["pluginName", "status"])
		.index("by_pluginName", ["pluginName"]),

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
		event: v.union(v.literal("files.upload.completed"), v.literal("users.account.deleted")),
		/**
		 * Absent for an event that carries no file. It stays an equality component of the dispatch
		 * index: Convex indexes a missing field as `undefined`, so such an event is dispatched with
		 * `.eq("contentType", undefined)` and still reads one range instead of scanning.
		 */
		contentType: v.optional(v.string()),
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
		// Both are absent for an event that fires on something other than a file.
		assetId: v.optional(v.id("files_r2_assets")),
		fileNodeId: v.optional(v.id("files_nodes")),
		/**
		 * Whoever the event is about: the uploader, the admin who asked for a run, or the deleted user.
		 */
		actorUserId: v.id("users"),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		event: v.union(
			v.literal("files.upload.completed"),
			v.literal("files.run.requested"),
			v.literal("users.account.deleted"),
			v.literal("ui.invoke.requested"),
		),
		eventId: v.string(),
		/**
		 * The manifest backend endpoint an invoke run targets. Only invoke runs set it.
		 */
		endpointId: v.optional(v.string()),
		/**
		 * The serialization lock this run holds while queued or running: the literal
		 * "installation", or `<endpointId>:<callerKey>` for a caller-key endpoint. The run record
		 * itself is the lock — a second run with the same live key answers busy.
		 */
		serializationKey: v.optional(v.string()),
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
		.index("by_installation_serializationKey_status", ["installationId", "serializationKey", "status"])
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
		/** Set only for file-view sessions: the file node the view was opened for. Page sessions leave it unset. */
		fileNodeId: v.optional(v.id("files_nodes")),
		tokenHash: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
		/**
		 * The scheduled job that deletes this doc at `expiresAt`. The deletion is what ends live
		 * plugin subscriptions, because Convex reruns queries on writes, not on wall clock. Refresh
		 * cancels this job and schedules a new one for the new expiry.
		 */
		expiryJobId: v.optional(v.id("_scheduled_functions")),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_installation", ["installationId"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
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
		.index("by_repository_cleanupAt", ["repositoryId", "cleanupAt"])
		.index("by_pluginName_cleanupAt", ["pluginName", "cleanupAt"])
		.index("by_pluginName", ["pluginName"]),

	/**
	 * Plugin-owned document store. A plugin keeps its structured data here instead of adding tables
	 * to the core app schema, the same way installation configuration keeps plugin settings out of
	 * it. One doc is one document: an installation, a collection inside that installation, and a key
	 * inside that collection.
	 */
	plugins_data: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		/**
		 * Denormalized from the installation so a doc states its own scope without a second read.
		 */
		pluginName: v.string(),
		collection: v.string(),
		key: v.string(),
		/**
		 * The plugin's own JSON object. The app never reads inside it, so it stays a record of
		 * unknown values like the other externally-owned payloads in this schema.
		 */
		value: v.record(v.string(), v.any()),
		/**
		 * UTF-8 byte size of the canonical JSON encoding of `value`, charged to the installation total.
		 */
		byteSize: v.number(),
		/**
		 * Grows by one on every accepted write. A `versioned` document accepts revision n only when
		 * the stored revision is n - 1, so one external producer can replay a lost response safely.
		 */
		revision: v.number(),
		/**
		 * `versioned` binds the key to `producerPrincipalKey` for good. The normal interactive routes
		 * then refuse that key, so a plugin page cannot race the producer's ordered outbox.
		 */
		writeMode: v.union(v.literal("normal"), v.literal("versioned")),
		/**
		 * Set only for `versioned`: the one service principal allowed to write this key.
		 */
		producerPrincipalKey: v.optional(v.string()),
		/**
		 * `owned` binds the doc to its `createdBy`: only that member may change or delete it through
		 * any interactive writer. `shared` docs follow the normal content.write rule.
		 */
		ownership: v.union(v.literal("shared"), v.literal("owned")),
		/**
		 * Set only by the user-write door's append: the caller's idempotency key, scoped per creator.
		 */
		userWriteRequestId: v.optional(v.string()),
		/**
		 * Digest of the append request that created this doc. A replayed append with the same digest
		 * answers with the stored key; a different digest under the same request id is refused.
		 */
		userWriteRequestFingerprint: v.optional(v.string()),
		/**
		 * Original append byte size, kept so a delete can preserve the exact lost-response answer.
		 */
		userWriteResultByteSize: v.optional(v.number()),
		createdBy: v.id("users"),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
		/**
		 * The member whose per-member share holds this document's bytes and slot. Absent means the
		 * document is charged to the installation only, which is what every row written before the
		 * per-member ceilings existed looks like. A frame door or an API key charges its writer; a
		 * plugin backend charges nobody. The field moves with the document: a frame patch by another
		 * member credits the old member and charges the new one. The generation id below decides which
		 * exact counter row receives that credit after a member leaves and later rejoins.
		 */
		chargedTo: v.optional(v.id("users")),
		/**
		 * Exact member counter generation that owns this document's share. Absent legacy docs are uncharged.
		 */
		chargedToMemberUsageId: v.optional(v.id("plugins_data_member_usage")),
		/**
		 * How many of this document's current bytes a plugin backend wrote. A backend write or patch
		 * sets it to the document's new `byteSize`; a write by a member — through a frame door or an
		 * API key — sets it to 0, because the member composed the value that is now stored. The
		 * per-member ceiling then compares `usedBytes - machineBytes`, so a backend cannot fill a
		 * member's share and lock them out, and a member cannot launder their own bytes by asking the
		 * backend to touch their keys. Absent means zero.
		 */
		machineBytes: v.optional(v.number()),
		/**
		 * The private scope this document belongs to, or absent when it is visible to the whole
		 * workspace.
		 *
		 * The writer never supplies it. The write door resolves it from the key, through the longest
		 * `plugins_data_scopes` prefix that matches, so a caller cannot put a public document inside a
		 * private range or the other way round.
		 *
		 * Optional because the field arrived on a populated table, and Convex validates every existing
		 * row against the schema at push time. Absent reads back as `undefined`, which an index matches
		 * with an ordinary equality, so an unscoped read is still an index scan and not a filter.
		 */
		scopeId: v.optional(v.string()),
	})
		.index("by_installation_collection_key", ["installationId", "collection", "key"])
		/**
		 * Reads one scope's key range, and — with `scopeId` equal to `undefined` — the unscoped part of
		 * a collection. Every read door uses it so a member sees only what they may see, with
		 * `truncated` and `incomplete` computed from that same scan. Filtering a raw read afterwards
		 * would return fewer rows than the limit while the seam markers still described the raw read.
		 */
		.index("by_installation_collection_scope_key", ["installationId", "collection", "scopeId", "key"])
		/**
		 * Reads one collection in creation order. Convex appends `_creationTime` as the final sort
		 * key, so this index needs no stored timestamp field and no backfill.
		 *
		 * It must not carry `updatedAt`: an edit and a soft delete both patch the document, so an
		 * `updatedAt` order would push a three-month-old message a member just fixed a typo in to the
		 * top of everyone's catch-up read, and would make a "Message deleted" tombstone the newest
		 * item there.
		 */
		.index("by_installation_collection", ["installationId", "collection"])
		/**
		 * The same creation-order read, one scope at a time. `scopeId` sits before the implicit
		 * `_creationTime` sort key, so an equality on it keeps creation order inside the scope — and
		 * with `undefined` it reads the unscoped half of the collection.
		 */
		.index("by_installation_collection_scope", ["installationId", "collection", "scopeId"])
		/**
		 * Invalidation feed: documents in one collection (and one scope, or the unscoped half)
		 * ordered by `updatedAt`. `watch_recent` must not use this — an edit would jump to the top
		 * of a new-messages catch-up read. `watch_changes` exists for that "what changed since X"
		 * question. Soft-delete `put`s stay in the table and move here; a physical delete does not.
		 */
		.index("by_installation_collection_scope_updatedAt", ["installationId", "collection", "scopeId", "updatedAt"])
		.index("by_installation_collection_createdBy_requestId", [
			"installationId",
			"collection",
			"createdBy",
			"userWriteRequestId",
		])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Keeps an append's exact answer after its document is deleted. Without this receipt, retrying a
	 * request whose first response was lost would recreate content that another page already deleted.
	 */
	plugins_data_append_replay_receipts: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		collection: v.string(),
		createdBy: v.id("users"),
		requestId: v.string(),
		requestFingerprint: v.string(),
		result: v.object({ key: v.string(), revision: v.number(), byteSize: v.number() }),
		/**
		 * The exact member counter row whose held slot this receipt owns.
		 */
		memberUsageId: v.optional(v.id("plugins_data_member_usage")),
		expiresAt: v.number(),
	})
		.index("by_installation_collection_createdBy_requestId", [
			"installationId",
			"collection",
			"createdBy",
			"requestId",
		])
		.index("by_createdBy", ["createdBy"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * One accounting doc per installation. The store has a byte ceiling and a slot ceiling, and
	 * neither can be answered by counting docs at write time, so the owning mutation keeps these
	 * counters in the same transaction as the document it changes. That makes this a hot doc:
	 * concurrent writes to one installation can lose an optimistic-concurrency race and retry.
	 */
	plugins_data_usage: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		/**
		 * Sum of `plugins_data.byteSize` for this installation.
		 */
		usedBytes: v.number(),
		/**
		 * Bytes promised to live reservations that no stored value has claimed yet.
		 */
		reservedBytes: v.number(),
		/**
		 * Live documents. A deleted append moves its slot to `tombstoneDocuments`.
		 */
		usedDocuments: v.number(),
		reservedDocuments: v.number(),
		/**
		 * Released reservations, revision tombstones, and deleted-append receipts inside their retry horizon.
		 */
		tombstoneDocuments: v.number(),
		/**
		 * Every collection that currently holds a document or a live reservation. It is bounded by the
		 * collection limit, so the 16-collection rule can be enforced without scanning the store.
		 */
		collectionNames: v.array(v.string()),
		updatedAt: v.number(),
	})
		.index("by_installation", ["installationId"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * One accounting doc per member per installation. The installation-wide ceilings above cannot
	 * stop one member from filling the whole store, so an interactive write is also charged to a
	 * share of the installation's capacity. A row exists only while that member holds something: the
	 * credit path deletes it once every counter reaches zero, so a departed member leaves nothing.
	 *
	 * This is a second document in every accepted interactive write's transaction, which costs
	 * contention on top of the installation accounting doc. The alternative — a per-member map on
	 * that doc — wedges the installation once the map grows past what one document may hold, and
	 * cannot be ranged for a membership prune. The contention is the price of both.
	 */
	plugins_data_member_usage: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		userId: v.id("users"),
		/**
		 * Present on rows whose documents point back to this exact counter generation.
		 */
		generation: v.optional(v.literal("document_bound")),
		/**
		 * Sum of `plugins_data.byteSize` for the documents charged to this member.
		 */
		usedBytes: v.number(),
		/**
		 * Live documents plus deleted-append receipts charged to this member.
		 */
		usedDocuments: v.number(),
		/**
		 * Sum of `plugins_data.machineBytes` over the same documents. The member ceiling compares
		 * `usedBytes - machineBytes`, so bytes a plugin backend wrote never count against the member.
		 */
		machineBytes: v.number(),
		/**
		 * Every collection this member created that still exists. It is bounded by the installation's
		 * own collection limit, so the per-member collection share can be enforced without a scan.
		 * When the installation drops an empty collection, the name is removed from every member row.
		 */
		collectionNames: v.array(v.string()),
	})
		// The write path. `check_capacity` runs inside every accepted write, so this must resolve
		// exactly one document rather than range over the installation's members.
		.index("by_installation_user", ["installationId", "userId"])
		// Account deletion. `db_finalize_deleted_user` knows only the user id.
		.index("by_user", ["userId"])
		// The uninstall drain.
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"])
		// The membership prune. Removing a member from an organization removes them from every
		// workspace in it, so the prune runs once per membership and never per installation.
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"]),

	/**
	 * Capacity held for one exact document before an external side effect happens. A service that is
	 * about to create something it cannot take back reserves first, so a full store cannot refuse the
	 * write afterwards. The reservation also survives a lost HTTP response: an exact replay of the
	 * same idempotency key is answered from this row instead of reserving twice.
	 */
	plugins_data_reservations: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		collection: v.string(),
		key: v.string(),
		/**
		 * The service principal that owns this reservation. It survives token rotation.
		 */
		ownerPrincipalKey: v.string(),
		maximumBytes: v.number(),
		/**
		 * Bytes still held. Storing or growing the value moves the delta from here into `usedBytes`.
		 */
		remainingBytes: v.number(),
		/**
		 * `released` keeps the doc as a retry record until `retryHorizonExpiresAt`.
		 */
		state: v.union(v.literal("live"), v.literal("released")),
		/**
		 * Unique per installation and principal. It is what makes a replay recognizable.
		 */
		idempotencyKey: v.string(),
		/**
		 * The canonical encoding of the reserve request, compared as a whole string. A replay with
		 * different fields is refused, not reserved. It is not a hash and nothing secret is in it.
		 */
		requestFingerprint: v.string(),
		/**
		 * Set when the reservation is released, and frozen so a replayed release answers the same
		 * thing twice. A reserve has no such field on purpose: a replayed reserve is answered from the
		 * live row, because an ordered write spends part of the reservation and a frozen number would
		 * promise bytes that are already gone.
		 */
		releaseResult: v.optional(
			v.object({
				releasedBytes: v.number(),
			}),
		),
		/**
		 * True only while this released retry doc owns one `tombstoneDocuments` slot.
		 */
		holdsUsageTombstoneSlot: v.boolean(),
		releasedAt: v.optional(v.number()),
		/**
		 * A live reservation past this time is released by the expiry cron.
		 */
		expiresAt: v.number(),
		/**
		 * After this time the released retry record is deleted and its slot returns.
		 */
		retryHorizonExpiresAt: v.number(),
		updatedAt: v.number(),
	})
		// `state` sits before the collection so a lookup asks the index for the one live reservation.
		// One key collects a released retry record per reserve, and they stay for a day after the
		// reservation expires, so a query that read the key's docs and filtered afterwards would have to
		// read past all of them. Past enough of them it would stop before the live one and miss it.
		.index("by_installation_state_collection_key", ["installationId", "state", "collection", "key"])
		.index("by_installation_state_collection_key_owner_holds_slot", [
			"installationId",
			"state",
			"collection",
			"key",
			"ownerPrincipalKey",
			"holdsUsageTombstoneSlot",
		])
		.index("by_installation_principal_idempotencyKey", ["installationId", "ownerPrincipalKey", "idempotencyKey"])
		// `state` comes first so the expiry cron reads only live docs. Without it, a workspace holding
		// many released retry records would fill every batch with docs that need nothing, and the live
		// ones behind them would never be reached.
		.index("by_state_expiresAt", ["state", "expiresAt"])
		.index("by_retryHorizonExpiresAt", ["retryHorizonExpiresAt"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Marks a key its producer deleted for good. The value doc is physically gone and its bytes are
	 * already back, so reads and lists treat the key as absent. The tombstone exists only to refuse
	 * writes the producer sent before the delete and that arrive after it, until its retry horizon.
	 */
	plugins_data_revision_tombstones: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		collection: v.string(),
		key: v.string(),
		/**
		 * The delete's revision. Every lower revision and every later write is refused.
		 */
		revision: v.number(),
		producerPrincipalKey: v.string(),
		deletedAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_installation_collection_key", ["installationId", "collection", "key"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * A private range inside one installation's data store: a private channel, or a direct message.
	 *
	 * The scope binds one key prefix across one or more collections, one row per collection. Every
	 * document written under that prefix carries the scope id, and only a member the scope names may
	 * read or write there. The binding lives on the server because the write door has to resolve a
	 * scope from the key alone — a caller that could name its own scope could put a private document
	 * in a public range, or the reverse.
	 *
	 * One scope spans collections because a private area is never one collection. A private channel
	 * keeps its name, its messages, its thread replies and its reactions in four of them, all under
	 * the channel's key. One scope per collection would work, but it would cost the member four
	 * scopes against their cap for one channel, and a scope they held on three of the four would
	 * leak the fourth.
	 *
	 * Who may read it is not stored here. It is stored as ordinary permission grants on
	 * `access_control_permission_grants`, with `resourceKind: "plugin_scope"` and
	 * `resourceId: "<installationId>:<scopeId>"`. Removing a member revokes those grants in the same
	 * transaction, then schedules bounded cleanup for any scope whose last grant disappeared.
	 */
	plugins_data_scopes: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		/**
		 * Minted by the plugin, unique inside one installation.
		 */
		scopeId: v.string(),
		collection: v.string(),
		keyPrefix: v.string(),
		/**
		 * The member who created the scope. They receive the first `manage` grant on it.
		 */
		createdByUserId: v.id("users"),
		createdAt: v.number(),
		/**
		 * Durable last accepted append in this collection. Optional while old rows are backfilled.
		 */
		lastAppend: v.optional(
			v.union(
				v.null(),
				v.object({ at: v.number(), key: v.string(), createdByUserId: v.id("users") }),
			),
		),
		/**
		 * Count accepted appends in this collection. Optional while old rows are backfilled.
		 */
		appendSequence: v.optional(v.number()),
		/**
		 * Shared by every row of one scope. Increase it for each accepted membership change.
		 */
		updatedAt: v.number(),
	})
		.index("by_installation_scope", ["installationId", "scopeId"])
		// Resolves a write's key to its scope. Read `keyPrefix` downwards from the key and stop at the
		// first row the key starts with: that row is the longest matching prefix.
		.index("by_installation_collection_prefix", ["installationId", "collection", "keyPrefix"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Durable private-scope lifecycle records. One row whose `collectionName` and `keyPrefix` are both
	 * empty reserves each scope id for this installation's lifetime. Creation stops at 1,000 identity
	 * rows, so these durable records stay bounded. Real collection names and key prefixes cannot be
	 * empty, so that identity row can never fence a write.
	 *
	 * Other rows keep every released key range closed, including an empty scope: an old frame may
	 * still send private data after deletion, and that write must not become public. Scope creation
	 * refuses parent or child overlap with those real range rows, so the greatest-prefix lookup stays
	 * exact.
	 */
	plugins_data_released_scope_ranges: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		scopeId: v.string(),
		collectionName: v.string(),
		keyPrefix: v.string(),
	})
		.index("by_installation_scope", ["installationId", "scopeId"])
		.index("by_installation_collection_prefix", ["installationId", "collectionName", "keyPrefix"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * One doc binds a plugin-owned file node's reader list to a plugin-data scope. The host keeps
	 * exactly one `content.read` grant per active scope member on the node, updating them in the
	 * same mutations that change the scope's membership. At most
	 * `MAX_ACCESS_BINDINGS_PER_SCOPE` (4) nodes per scope keep that synchronous work bounded.
	 */
	plugins_file_access_bindings: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		scopeId: v.string(),
		nodeId: v.id("files_nodes"),
		updatedAt: v.number(),
	})
		.index("by_installation_scopeId", ["installationId", "scopeId"])
		.index("by_node", ["nodeId"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Bearer grant for a service that acts for one installation (`psg_` tokens, stored hashed). It is
	 * bound to the installation, not to a user session, so an external worker can finish work the
	 * member started. Every call still rechecks that the installation is enabled and still accepts
	 * the matching capabilities, so uninstalling or removing a capability revokes it.
	 */
	plugin_service_grants: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		pluginName: v.string(),
		/**
		 * The member whose plugin-page token was exchanged for this grant. Kept for audit.
		 */
		actorUserId: v.id("users"),
		tokenHash: v.string(),
		scopes: v.array(v.union(v.literal("plugin_data:read"), v.literal("plugin_data:write"), v.literal("files:write"))),
		/**
		 * Stable across token rotation, so reservations and versioned documents stay owned by the
		 * same producer after the raw token changes.
		 */
		principalKey: v.string(),
		/**
		 * `interactive` is what the grant exchange mints. `processing` comes only from the
		 * `seal-processing` route, which pins `destinationPathPrefix` below and gives the grant its
		 * recovery window. Only a `processing` grant may upload files. Both phases still resolve with
		 * the actor's live membership and permission checks: the seal bounds where a grant writes, not
		 * whether its member may still write.
		 */
		phase: v.union(v.literal("interactive"), v.literal("processing")),
		/**
		 * Absolute path prefix this grant may write under. Null means it may not write files.
		 */
		destinationPathPrefix: v.union(v.string(), v.null()),
		expiresAt: v.number(),
		revokedAt: v.optional(v.number()),
		revokedReason: v.optional(v.string()),
		updatedAt: v.number(),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_actorUser", ["actorUserId"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"])
		// Removing a member deletes their grants by this index, the same way it deletes their public API
		// grants and plugin UI sessions.
		.index("by_organization_workspace_actorUser", ["organizationId", "workspaceId", "actorUserId"]),

	/**
	 * One file a service upload stores in a workspace. The doc is the durable answer to a replayed
	 * create/remint/finalize call and the R2 event. It captures ownership and the actual stored size,
	 * so a later deletion of the exact canonical R2 object can find what this file charged — even
	 * after the installation is gone.
	 */
	plugin_service_storage_targets: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		/**
		 * The upload run this file belongs to, chosen by the service. One processing run reuses one
		 * key for all its files, so the same `targetKey` in a later run is a different file.
		 */
		idempotencyKey: v.string(),
		/**
		 * Stable key for this one file inside its upload run.
		 */
		targetKey: v.string(),
		/**
		 * A different request under the same run and target key is refused, not stored twice.
		 */
		requestFingerprint: v.string(),
		/**
		 * Historical targets omit these flags and behave as false. New targets always store both.
		 */
		readOnly: v.optional(v.boolean()),
		nonCollaborative: v.optional(v.boolean()),
		/**
		 * The authoritative sealed replay fence and its stable destination node id at create time.
		 */
		destinationPath: v.string(),
		destinationNodeId: v.id("files_nodes"),
		/**
		 * Logical service lifecycle under this destination. Older dev targets omit it and belong to
		 * epoch 1. The first create after an archive opens the next epoch.
		 */
		destinationEpoch: v.optional(v.number()),
		path: v.string(),
		contentType: v.string(),
		/**
		 * The size the service guessed at create time. Nothing is charged for it.
		 */
		declaredBytes: v.number(),
		/**
		 * The stored size R2 confirmed, and the amount already charged for this target. `null` until an
		 * object event arrives. Nothing is charged before that, so this one number is both.
		 */
		actualBytes: v.union(v.number(), v.null()),
		nodeId: v.id("files_nodes"),
		assetId: v.id("files_r2_assets"),
		/**
		 * `pending` until the canonical object is confirmed and settled, then `committed`. `released`
		 * means the target holds no live file any more: the upload expired, the service cancelled it
		 * before it finished, or the per-target delete archived the committed file. The bytes it already
		 * charged stay charged either way.
		 */
		state: v.union(v.literal("pending"), v.literal("committed"), v.literal("released")),
		/**
		 * Set after the file leaves this service door through a member move or service destination archive.
		 */
		movedOutAt: v.optional(v.number()),
		/**
		 * Set when the service's delete route archived a committed file. It marks that actualBytes is
		 * the immutable canonical size and keeps the released target as the replay answer.
		 */
		deleteRequestedAt: v.optional(v.number()),
		/**
		 * The member whose sealed grant created this target. Kept for audit and file authorship.
		 */
		createdBy: v.id("users"),
		updatedAt: v.number(),
	})
		// Create, remint and finalize find one file by the run it belongs to and its key inside that
		// run. Two runs may reuse a target key for different files, so the run key comes first.
		.index("by_organization_workspace_installation_idempotencyKey_targetKey", [
			"organizationId",
			"workspaceId",
			"installationId",
			"idempotencyKey",
			"targetKey",
		])
		// Physical deletion settlement finds the charged target by the deleted canonical asset.
		.index("by_asset", ["assetId"])
		// A service destination archive detaches only the targets for the file nodes it archives.
		.index("by_node", ["nodeId"])
		// A restored older destination generation proves its service ownership by stable folder id.
		.index("by_org_workspace_installation_destinationPath_destinationNode", [
			"organizationId",
			"workspaceId",
			"installationId",
			"destinationPath",
			"destinationNodeId",
		])
		.index("by_organization_workspace_installation_destinationPath", [
			"organizationId",
			"workspaceId",
			"installationId",
			"destinationPath",
		])
		// Bound live cross-run cleanup to one sealed destination and target key. Released history is
		// deliberately outside the live state prefixes used by create and delete.
		.index("by_delete_group_state", [
			"organizationId",
			"workspaceId",
			"installationId",
			"destinationPath",
			"targetKey",
			"state",
			"movedOutAt",
			"deleteRequestedAt",
		])
		// The archive route finds one target under the sealed destination without scanning an
		// installation's full upload history. The stable node id then survives a folder rename.
		.index("by_organization_workspace_installation_path", ["organizationId", "workspaceId", "installationId", "path"])
		// The delete route finds targets by key inside the installation; the uninstall/workspace drain
		// uses the same index as a tenant-scope prefix.
		.index("by_organization_workspace_installation_targetKey", [
			"organizationId",
			"workspaceId",
			"installationId",
			"targetKey",
		]),

	/**
	 * Close every older target generation when the service archives one sealed destination.
	 */
	plugin_service_storage_destinations: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		destinationPath: v.string(),
		currentEpoch: v.number(),
		closedEpoch: v.number(),
		closedAt: v.optional(v.number()),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_installation_destinationPath", [
			"organizationId",
			"workspaceId",
			"installationId",
			"destinationPath",
		])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	// #endregion plugins

	// #region activities
	/**
	 * Workspace activity feed: one doc per user-visible unit of background work. Producers write
	 * activities only inside their own mutations (never from actions), so the activity can never
	 * drift from the domain state it mirrors. The producer finds its activity through the
	 * `by_source_id` index and owns its lifecycle, including deleting it on retention.
	 */
	activities: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/** Who triggered the work. Activities are workspace-shared, not a per-user inbox. */
		userId: v.id("users"),
		/** "timeout" = the deadline cron closed it because the producer never finished it in time. */
		status: v.union(v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("timeout")),
		/** What produced this activity. Wrap in v.union(...) when a second producer variant lands. */
		source: v.object({
			type: v.literal("plugin_run"),
			id: v.id("plugins_event_runs"),
			installationId: v.id("plugins_workspace_installations"),
			pluginName: v.string(),
		}),
		/** Status-neutral display text, e.g. "Video plugin · speakers.mp4". */
		title: v.string(),
		errorMessage: v.union(v.string(), v.null()),
		/**
		 * Entities the work touches, appended as the producer creates them; UIs use these to link
		 * and to decorate rows. Bounded by the producer (plugin runs: the 20-call quota).
		 */
		targets: v.array(
			v.object({
				type: v.literal("file_node"),
				id: v.id("files_nodes"),
				path: v.string(),
				/** Per-target display text (e.g. "Writing the transcript"); "" = none, UIs fall back to the activity title. */
				message: v.string(),
			}),
		),
		/** Caller-set deadline (at most 5 minutes after start); past it, the cron closes the activity as "timeout". */
		timeoutAt: v.number(),
		finishedAt: v.optional(v.number()),
		/** 0 = not archived; the dismiss time once a user dismisses a finished activity. Archived items stay for producers. */
		archivedAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_archivedAt_updatedAt", [
			"organizationId",
			"workspaceId",
			"archivedAt",
			"updatedAt",
		])
		// The producer→activity link lives only here (no back-link on the producer doc): the
		// producer finds its activity through this index, and its absence means "never opted in".
		.index("by_source_id", ["source.id"])
		// The timeout cron scans only overdue running activities through this index.
		.index("by_status_timeoutAt", ["status", "timeoutAt"]),

	// #endregion activities

	// #region chat messages
	/**
	 * Chat messages table - a single table that represents both threads and messages.
	 * Root messages have `threadId = null`.
	 * Child messages have `threadId = rootId`.
	 *
	 * Any message can also be the root of a descendant thread by using that message id as
	 * the thread id for future children.
	 *
	 * Every row is a comment on one file. `fileNodeId` says which one, and that file answers the
	 * permission question for reading and writing the comment: a comment quotes the document, so
	 * somebody who may not open the file may not read what was said about it either.
	 */
	chat_messages: defineTable({
		/** Organization ID for multi-tenant scoping */
		organizationId: v.string(),
		/** Workspace ID for multi-tenant scoping */
		workspaceId: v.string(),
		/**
		 * The file this comment is about, and the thing every read and write of it is checked against.
		 *
		 * Required, so a row can never exist without a permission subject. Children copy it from their
		 * root, so a whole thread always answers to one file.
		 */
		fileNodeId: v.id("files_nodes"),
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
		.index("by_user_eligibleAt", ["userId", "eligibleAt"])
		.index("by_user", ["userId"]),
	// #endregion data deletion

	// #region access control

	/**
	 * Custom roles, which always apply to the whole organization. System roles live in code, so they
	 * have no docs here.
	 **/
	access_control_roles: defineTable({
		organizationId: v.id("organizations"),
		name: v.string(),
		/** `name` in lowercase, without spaces around it. Unique per organization, never a system role name. */
		normalizedName: v.string(),
		description: v.string(),
		permissions: v.array(access_control_permission_validator),
		/** Kept even after that user is deleted: the role belongs to the organization, not to them. */
		createdBy: v.id("users"),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index("by_organization_normalizedName", ["organizationId", "normalizedName"]),

	access_control_role_assignments: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		role: access_control_role_ref_validator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// `role` is left out of this key on purpose. There is one assignment per (organization,
		// workspace, user), so changing a role updates the existing doc instead of adding a second one.
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_organization_user_workspace", ["organizationId", "userId", "workspaceId"])
		.index("by_user_organization_workspace", ["userId", "organizationId", "workspaceId"])
		.index("by_organization_role_workspace_user", ["organizationId", "role", "workspaceId", "userId"]),

	access_control_permission_grants: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/**
		 * What the grant is about. `"thread"` is never written: no code makes a thread grant, and
		 * `access_control_Resource` cannot build one. Chat threads are checked with `content.read` and
		 * `content.write` on their workspace instead. The literal stays so old docs still validate.
		 *
		 * `"plugin_scope"` is a private range of one plugin's data store — a private channel or a
		 * direct message. Its grants close a door instead of opening one: inside a scope a role gives
		 * nothing and only a grant that names the user gets in. See the `plugin_scope` branch in
		 * `access_control_db_has_permission`.
		 */
		resourceKind: v.union(
			v.literal("organization"),
			v.literal("workspace"),
			v.literal("file"),
			v.literal("thread"),
			v.literal("plugin_scope"),
		),
		/**
		 * The id of the thing this grant is about, written as a string.
		 *
		 * For `resourceKind: "file"` this is always the id of the restricted scope node — the folder that
		 * was restricted — never the id of the file that was opened. So a restricted folder and
		 * everything inside it share one set of grants.
		 */
		resourceId: v.string(),
		principalKind: v.union(v.literal("role"), v.literal("user"), v.literal("public")),
		userId: v.optional(v.id("users")),
		role: v.optional(access_control_role_ref_validator),
		permission: access_control_permission_validator,
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
		// Count one `content.read` row per private scope without reading every permission row.
		.index("by_user_org_workspace_kind_principal_permission_resource", [
			"userId",
			"organizationId",
			"workspaceId",
			"resourceKind",
			"principalKind",
			"permission",
			"resourceId",
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
		])
		// Finds every grant that still points at one role, so deleting a custom role can refuse.
		// `principalKind` comes first, like in the three lookups above, instead of trusting that
		// `role` is only ever set on a doc whose principal is a role.
		.index("by_organization_role_workspace_resource", [
			"organizationId",
			"principalKind",
			"role",
			"workspaceId",
			"resourceKind",
			"resourceId",
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
		/**
		 * Keep every plugin authority door closed across delayed or bounded workspace purge.
		 */
		pluginDataPurgeStartedAt: v.optional(v.number()),
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
		/**
		 * `true` while organization removal drains this member's direct grants. Account recovery must
		 * not reactivate this membership. Optional while older stored memberships have no marker.
		 */
		pendingOrganizationRemoval: v.optional(v.boolean()),
	})
		.index("by_workspace_user_active", ["workspaceId", "userId", "active"])
		.index("by_user_organization_workspace_active", ["userId", "organizationId", "workspaceId", "active"])
		.index("by_active_organization_workspace_user", ["active", "organizationId", "workspaceId", "userId"])
		.index("by_active_user_organization_workspace", ["active", "userId", "organizationId", "workspaceId"]),

	quotas: defineTable({
		quotaName: v.union(
			v.literal("extra_organizations"),
			v.literal("extra_workspaces"),
			v.literal("active_api_credentials"),
			v.literal("public_api_upload_bytes"),
			v.literal("plugin_service_storage_bytes"),
		),
		userId: v.optional(v.id("users")),
		organizationId: v.optional(v.id("organizations")),
		workspaceId: v.optional(v.id("organizations_workspaces")),
		usedCount: v.number(),
		maxCount: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user_quotaName", ["userId", "quotaName"])
		.index("by_organization_quotaName", ["organizationId", "quotaName"])
		.index("by_workspace_quotaName", ["workspaceId", "quotaName"])
		.index("by_user_organization_workspace_quotaName", ["userId", "organizationId", "workspaceId", "quotaName"]),
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
		/** The current refresh JWT. The refresh route only accepts a byte-equal presented token. */
		token: v.string(),
		/**
		 * The refresh JWT this row held before the last rotation. A tab that raced the rotation can
		 * still present it once and receive the current token back, so the shared localStorage copy
		 * converges instead of falling into 401 → storage clear → new anonymous user. This is the
		 * standard grace window for refresh-token rotation; Auth0's rotation docs call it the
		 * "reuse interval" (see also RFC 9700 §4.14 on rotation).
		 */
		previousToken: v.optional(v.string()),
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
		/**
		 * Block account recovery while destructive deletion spans more than one transaction.
		 */
		deletionFinalizationStartedAt: v.optional(v.number()),
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
		/** 0 = not archived; the dismiss time once the user archives it. Mandatory so indexes can filter on it. */
		archivedAt: v.number(),
		actorUserId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_user_archivedAt", ["userId", "archivedAt"])
		.index("by_organization_user_archivedAt", ["organizationId", "userId", "archivedAt"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"]),

	// #endregion users
});

export default app_convex_schema;

export { app_convex_schema };

// @ts-expect-error unused type
type _ = ai_chat_UiMessage;
