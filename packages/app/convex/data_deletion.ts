import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import app_convex_schema from "./schema.ts";
import { data_deletion_db_request } from "../server/data_deletion.ts";
import { workspace_limits } from "../shared/limits.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const USER_DELETION_REQUEST_BATCH_SIZE = 20;
const WORKSPACE_DELETION_REQUEST_BATCH_SIZE = 50;
const PROJECT_DELETION_REQUEST_BATCH_SIZE = 200;

async function db_purge_workspace_project_content(
	ctx: MutationCtx,
	args: { workspaceId: Id<"workspaces">; projectId: Id<"workspaces_projects"> },
) {
	const { workspaceId, projectId } = args;

	// --- collect ids (read everything first; see TODO on purge for large-tenant limits) ---

	// pages_pending_edits (tenant docs + cleanup tasks + page ids used to locate `pages_yjs_snapshot_schedules` docs)
	const pendingEditIds: Array<Id<"pages_pending_edits">> = [];
	for await (const row of ctx.db.query("pages_pending_edits")) {
		if (row.workspaceId === workspaceId && row.projectId === projectId) {
			pendingEditIds.push(row._id);
		}
	}

	const pendingEditCleanupTaskIds: Array<Id<"pages_pending_edits_cleanup_tasks">> = [];
	for (const pendingEditId of pendingEditIds) {
		const task = await ctx.db
			.query("pages_pending_edits_cleanup_tasks")
			.withIndex("by_pendingEditId", (q) => q.eq("pendingEditId", pendingEditId))
			.first();
		if (task) {
			pendingEditCleanupTaskIds.push(task._id);
		}
	}

	const pageIds: Array<Id<"pages">> = [];
	for await (const page of ctx.db
		.query("pages")
		.withIndex("by_workspaceId_projectId_parentId_name", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		pageIds.push(page._id);
	}

	const pagesYjsSnapshotScheduleIds: Array<Id<"pages_yjs_snapshot_schedules">> = [];
	for (const pageId of pageIds) {
		const sched = await ctx.db
			.query("pages_yjs_snapshot_schedules")
			.withIndex("by_page_id", (q) => q.eq("page_id", pageId))
			.first();
		if (sched) {
			pagesYjsSnapshotScheduleIds.push(sched._id);
		}
	}

	// ai_chat_threads_messages_aisdk_5
	const aiChatThreadsMessagesAisdk5Ids: Array<Id<"ai_chat_threads_messages_aisdk_5">> = [];
	for await (const row of ctx.db
		.query("ai_chat_threads_messages_aisdk_5")
		.withIndex("by_workspace_project_thread", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))) {
		aiChatThreadsMessagesAisdk5Ids.push(row._id);
	}

	// ai_chat_threads
	const aiChatThreadsIds: Array<Id<"ai_chat_threads">> = [];
	for await (const row of ctx.db
		.query("ai_chat_threads")
		.withIndex("by_workspace_project_archived_last_message_at", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		aiChatThreadsIds.push(row._id);
	}

	// chat_messages
	const chatMessagesIds: Array<Id<"chat_messages">> = [];
	for await (const row of ctx.db
		.query("chat_messages")
		.withIndex("by_workspace_project_thread", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))) {
		chatMessagesIds.push(row._id);
	}

	// pages_pending_edits_last_sequence_saved (full table scan; filter in memory)
	const pagesPendingEditsLastSequenceSavedIds: Array<Id<"pages_pending_edits_last_sequence_saved">> = [];
	for await (const row of ctx.db.query("pages_pending_edits_last_sequence_saved")) {
		if (row.workspaceId === workspaceId && row.projectId === projectId) {
			pagesPendingEditsLastSequenceSavedIds.push(row._id);
		}
	}

	// pages_plain_text_chunks
	const pagesPlainTextChunksIds: Array<Id<"pages_plain_text_chunks">> = [];
	for await (const row of ctx.db
		.query("pages_plain_text_chunks")
		.withIndex("by_workspace_project_page_sequenceChunk", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		pagesPlainTextChunksIds.push(row._id);
	}

	// pages_markdown_chunks
	const pagesMarkdownChunksIds: Array<Id<"pages_markdown_chunks">> = [];
	for await (const row of ctx.db
		.query("pages_markdown_chunks")
		.withIndex("by_workspace_project_page_sequenceChunk", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		pagesMarkdownChunksIds.push(row._id);
	}

	// pages_yjs_snapshots
	const pagesYjsSnapshotsIds: Array<Id<"pages_yjs_snapshots">> = [];
	for await (const row of ctx.db
		.query("pages_yjs_snapshots")
		.withIndex("by_workspace_project_page_id_sequence", (q) =>
			q.eq("workspace_id", workspaceId).eq("project_id", projectId),
		)) {
		pagesYjsSnapshotsIds.push(row._id);
	}

	// pages_yjs_updates
	const pagesYjsUpdatesIds: Array<Id<"pages_yjs_updates">> = [];
	for await (const row of ctx.db
		.query("pages_yjs_updates")
		.withIndex("by_workspace_project_page_id_sequence", (q) =>
			q.eq("workspace_id", workspaceId).eq("project_id", projectId),
		)) {
		pagesYjsUpdatesIds.push(row._id);
	}

	// pages_yjs_docs_last_sequences
	const pagesYjsDocsLastSequencesIds: Array<Id<"pages_yjs_docs_last_sequences">> = [];
	for await (const row of ctx.db
		.query("pages_yjs_docs_last_sequences")
		.withIndex("by_workspace_project_page_id", (q) => q.eq("workspace_id", workspaceId).eq("project_id", projectId))) {
		pagesYjsDocsLastSequencesIds.push(row._id);
	}

	// pages_snapshots_contents
	const pagesSnapshotsContentsIds: Array<Id<"pages_snapshots_contents">> = [];
	for await (const row of ctx.db
		.query("pages_snapshots_contents")
		.withIndex("by_workspace_project_page_snapshot_id", (q) =>
			q.eq("workspace_id", workspaceId).eq("project_id", projectId),
		)) {
		pagesSnapshotsContentsIds.push(row._id);
	}

	// pages_snapshots
	const pagesSnapshotsIds: Array<Id<"pages_snapshots">> = [];
	for await (const row of ctx.db
		.query("pages_snapshots")
		.withIndex("by_workspace_project_page_id_archived_at", (q) =>
			q.eq("workspace_id", workspaceId).eq("project_id", projectId),
		)) {
		pagesSnapshotsIds.push(row._id);
	}

	// pages_markdown_content (full table scan)
	const pagesMarkdownContentIds: Array<Id<"pages_markdown_content">> = [];
	for await (const row of ctx.db.query("pages_markdown_content")) {
		if (row.workspace_id === workspaceId && row.project_id === projectId) {
			pagesMarkdownContentIds.push(row._id);
		}
	}

	// --- delete (same dependency order as before) ---

	// pages_pending_edits_cleanup_tasks
	await Promise.all(pendingEditCleanupTaskIds.map((id) => ctx.db.delete("pages_pending_edits_cleanup_tasks", id)));
	// pages_yjs_snapshot_schedules
	await Promise.all(pagesYjsSnapshotScheduleIds.map((id) => ctx.db.delete("pages_yjs_snapshot_schedules", id)));
	// ai_chat_threads_messages_aisdk_5
	await Promise.all(aiChatThreadsMessagesAisdk5Ids.map((id) => ctx.db.delete("ai_chat_threads_messages_aisdk_5", id)));
	// ai_chat_threads
	await Promise.all(aiChatThreadsIds.map((id) => ctx.db.delete("ai_chat_threads", id)));
	// chat_messages
	await Promise.all(chatMessagesIds.map((id) => ctx.db.delete("chat_messages", id)));
	// pages_pending_edits_last_sequence_saved
	await Promise.all(
		pagesPendingEditsLastSequenceSavedIds.map((id) => ctx.db.delete("pages_pending_edits_last_sequence_saved", id)),
	);
	// pages_pending_edits
	await Promise.all(pendingEditIds.map((id) => ctx.db.delete("pages_pending_edits", id)));
	// pages_plain_text_chunks
	await Promise.all(pagesPlainTextChunksIds.map((id) => ctx.db.delete("pages_plain_text_chunks", id)));
	// pages_markdown_chunks
	await Promise.all(pagesMarkdownChunksIds.map((id) => ctx.db.delete("pages_markdown_chunks", id)));
	// pages_yjs_snapshots
	await Promise.all(pagesYjsSnapshotsIds.map((id) => ctx.db.delete("pages_yjs_snapshots", id)));
	// pages_yjs_updates
	await Promise.all(pagesYjsUpdatesIds.map((id) => ctx.db.delete("pages_yjs_updates", id)));
	// pages_yjs_docs_last_sequences
	await Promise.all(pagesYjsDocsLastSequencesIds.map((id) => ctx.db.delete("pages_yjs_docs_last_sequences", id)));
	// pages_snapshots_contents
	await Promise.all(pagesSnapshotsContentsIds.map((id) => ctx.db.delete("pages_snapshots_contents", id)));
	// pages_snapshots
	await Promise.all(pagesSnapshotsIds.map((id) => ctx.db.delete("pages_snapshots", id)));
	// pages_markdown_content
	await Promise.all(pagesMarkdownContentIds.map((id) => ctx.db.delete("pages_markdown_content", id)));
	// pages
	await Promise.all(pageIds.map((id) => ctx.db.delete("pages", id)));
}

async function db_delete_data_deletion_requests(
	ctx: MutationCtx,
	args:
		| { scope: "user"; userId: Id<"users"> }
		| { scope: "workspace"; workspaceId: Id<"workspaces"> }
		| { scope: "project"; workspaceId: Id<"workspaces">; projectId: Id<"workspaces_projects"> },
) {
	if (args.scope === "user") {
		const rows = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_userId", (q) => q.eq("userId", args.userId))
			.collect();

		await Promise.all(
			rows.filter((row) => row.scope === "user").map((row) => ctx.db.delete("data_deletion_requests", row._id)),
		);

		return;
	}

	const rows = await ctx.db
		.query("data_deletion_requests")
		.withIndex(
			"by_workspace_project",
			args.scope === "project"
				? (q) => q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId)
				: (q) => q.eq("workspaceId", args.workspaceId),
		)
		.collect();

	await Promise.all(
		rows
			.filter((row) =>
				args.scope === "project" ? row.scope === "project" : row.scope === "workspace" && row.projectId === undefined,
			)
			.map((row) => ctx.db.delete("data_deletion_requests", row._id)),
	);
}

async function db_delete_workspace(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
	},
) {
	const projects = await ctx.db
		.query("workspaces_projects")
		.withIndex("by_workspace_default", (q) => q.eq("workspaceId", args.workspaceId))
		.collect();

	const projectRequestsToDelete = [];

	// Purge every project's tenant-scoped content before deleting the workspace
	// shell. Keep this layered on `db_purge_workspace_project_content` so
	// workspace teardown and standalone project requests share the same
	// project-content cleanup. Return the project ids afterward so the caller
	// can clear only the matching queued project requests it actually consumed.
	for (const project of projects) {
		await db_purge_workspace_project_content(ctx, {
			workspaceId: args.workspaceId,
			projectId: project._id,
		});

		projectRequestsToDelete.push({
			workspaceId: project.workspaceId,
			projectId: project._id,
		});
	}

	const workspaceStill = await ctx.db.get("workspaces", args.workspaceId);
	if (workspaceStill) {
		const [remainingProjects, limitsPerWorkspaceDocs] = await Promise.all([
			ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspace_default", (q) => q.eq("workspaceId", args.workspaceId))
				.collect(),
			ctx.db
				.query("limits_per_workspace")
				.withIndex("by_workspace_limit", (q) => q.eq("workspaceId", args.workspaceId))
				.collect(),
		]);

		await Promise.all(remainingProjects.map((project) => ctx.db.delete("workspaces_projects", project._id)));
		await Promise.all(limitsPerWorkspaceDocs.map((doc) => ctx.db.delete("limits_per_workspace", doc._id)));
		await ctx.db.delete("workspaces", args.workspaceId);
	}

	return {
		projectRequestsToDelete,
	};
}

async function db_prepare_user_for_deletion(
	ctx: MutationCtx,
	args: {
		user: Doc<"users">;
		now: number;
	},
) {
	// Clear billing snapshots during phase 1 so both scheduled and direct
	// deletion paths stop surfacing billing state immediately.
	const billingUsageSnapshots = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_userId", (q) => q.eq("userId", args.user._id))
		.collect();

	await Promise.all(billingUsageSnapshots.map((row) => ctx.db.delete("billing_usage_snapshots", row._id)));

	const memberships = await ctx.db
		.query("workspaces_projects_users")
		.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", args.user._id))
		.collect();

	if (args.user.deletedAt == null) {
		// Tombstone the user and deactivate memberships first so later checks can
		// tell which projects and workspaces became orphaned because of this user.
		await Promise.all(
			memberships.map((membership) =>
				ctx.db.patch("workspaces_projects_users", membership._id, {
					active: false,
					updatedAt: args.now,
				}),
			),
		);

		await ctx.db.patch("users", args.user._id, {
			deletedAt: args.now,
		});
	}

	const projectsToDelete = [];

	const candidateProjectWorkspaceIds = new Map(
		memberships.map((membership) => [membership.projectId, membership.workspaceId]),
	);
	// Detect orphaned non-default projects that lost their last active member but
	// still belong to a live shared workspace. Keep doing this even for an
	// already-tombstoned user so the direct hard-delete path can finish phase-1
	// orphan cleanup after an earlier scheduled init.
	for (const [projectId, workspaceId] of candidateProjectWorkspaceIds) {
		const activeMemberStillOnProject = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_active_workspace_project_user", (q) =>
				q.eq("active", true).eq("workspaceId", workspaceId).eq("projectId", projectId),
			)
			.first();
		if (activeMemberStillOnProject) {
			continue;
		}

		const project = await ctx.db.get("workspaces_projects", projectId);
		if (!project) {
			continue;
		}

		const activeMemberStillInWorkspace = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_active_workspace_project_user", (q) => q.eq("active", true).eq("workspaceId", project.workspaceId))
			.first();
		if (!activeMemberStillInWorkspace || project.default) {
			continue;
		}

		const workspace = await ctx.db.get("workspaces", project.workspaceId);
		if (!workspace) {
			continue;
		}

		const projectUserLookup = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_project_user_active", (q) => q.eq("projectId", projectId))
			.collect();

		projectsToDelete.push({
			workspaceId: workspace._id,
			projectId: project._id,
		});

		const limitDefinition = workspace_limits.EXTRA_PROJECTS;
		const limit = await ctx.db
			.query("limits_per_workspace")
			.withIndex("by_workspace_limit", (q) => q.eq("workspaceId", workspace._id).eq("limitName", limitDefinition.name))
			.first();

		if (limit) {
			if (limit.usedCount <= 0) {
				console.error("Trying to reduce a limit used count that is less than or equal to 0", limit);
			} else {
				await ctx.db.patch("limits_per_workspace", limit._id, {
					usedCount: limit.usedCount - 1,
					updatedAt: args.now,
				});
			}
		}

		await Promise.all(
			projectUserLookup.map((projectUser) => ctx.db.delete("workspaces_projects_users", projectUser._id)),
		);
		await ctx.db.delete("workspaces_projects", project._id);
	}

	return projectsToDelete;
}

async function db_finalize_deleted_user(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		now: number;
	},
) {
	const user = await ctx.db.get("users", args.userId);
	if (!user || user.deletedAt == null) {
		return;
	}

	const userIdString = String(user._id);
	const [membershipsAll, anonymousAuthTokens, userLimits, pendingEdits, lastSequenceSaved] = await Promise.all([
		ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", user._id))
			.collect(),
		ctx.db
			.query("users_anon_tokens")
			.withIndex("by_userId", (q) => q.eq("userId", user._id))
			.collect(),
		ctx.db
			.query("limits_per_user")
			.withIndex("by_user_limit_name", (q) => q.eq("userId", user._id))
			.collect(),
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_userId_pageId", (q) => q.eq("userId", userIdString))
			.collect(),
		ctx.db
			.query("pages_pending_edits_last_sequence_saved")
			.withIndex("by_userId_pageId", (q) => q.eq("userId", userIdString))
			.collect(),
	]);

	const pendingEditCleanupTasks = (
		await Promise.all(
			pendingEdits.map((row) =>
				ctx.db
					.query("pages_pending_edits_cleanup_tasks")
					.withIndex("by_pendingEditId", (q) => q.eq("pendingEditId", row._id))
					.collect(),
			),
		)
	).flat();

	// Keep the affected workspace ids before deleting memberships so you can
	// later detect which workspaces became fully empty after the user is gone.
	const affectedWorkspaceIds = new Set<Id<"workspaces">>();
	if (user.defaultWorkspaceId) {
		affectedWorkspaceIds.add(user.defaultWorkspaceId);
	}
	for (const membership of membershipsAll) {
		affectedWorkspaceIds.add(membership.workspaceId);
	}

	await Promise.all(pendingEditCleanupTasks.map((row) => ctx.db.delete("pages_pending_edits_cleanup_tasks", row._id)));
	await Promise.all(lastSequenceSaved.map((row) => ctx.db.delete("pages_pending_edits_last_sequence_saved", row._id)));
	await Promise.all(pendingEdits.map((row) => ctx.db.delete("pages_pending_edits", row._id)));
	await Promise.all(membershipsAll.map((row) => ctx.db.delete("workspaces_projects_users", row._id)));
	await Promise.all(anonymousAuthTokens.map((row) => ctx.db.delete("users_anon_tokens", row._id)));
	await Promise.all(userLimits.map((row) => ctx.db.delete("limits_per_user", row._id)));

	await ctx.db.patch("users", user._id, {
		clerkUserId: null,
		anonymousAuthToken: undefined,
		defaultWorkspaceId: undefined,
		defaultProjectId: undefined,
		deletedAt: user.deletedAt ?? args.now,
	});

	const workspacesToDelete = [];

	// Return only fully empty workspaces here. Let the caller own the actual
	// workspace purge so it can keep the surrounding request bookkeeping local.
	for (const workspaceId of affectedWorkspaceIds) {
		const workspace = await ctx.db.get("workspaces", workspaceId);
		if (!workspace) {
			continue;
		}

		const remainingMemberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_active_workspace_project_user", (q) => q.eq("active", true).eq("workspaceId", workspaceId))
			.first();
		if (remainingMemberships) {
			continue;
		}

		workspacesToDelete.push({
			workspaceId: workspace._id,
		});
	}
	return { workspacesToDelete };
}

export const init_user_deletion = internalMutation({
	args: {
		userId: v.id("users"),
		nowTs: v.optional(v.number()),
	},
	returns: v.union(v.id("data_deletion_requests"), v.null()),
	handler: async (ctx, args) => {
		const user = await ctx.db.get("users", args.userId);
		if (!user) {
			return null;
		}

		const now = args.nowTs ?? Date.now();
		const requestId = await data_deletion_db_request(ctx, {
			userId: args.userId,
			scope: "user",
		});

		// Run phase 1 immediately so the user is tombstoned now and orphaned
		// projects are discovered while the original memberships still exist.
		const projectsToDelete = await db_prepare_user_for_deletion(ctx, {
			user,
			now,
		});

		// Queue these orphaned project purges now so they age alongside the user
		// request instead of adding a second retention window later.
		for (const project of projectsToDelete) {
			await data_deletion_db_request(ctx, {
				userId: user._id,
				workspaceId: project.workspaceId,
				projectId: project.projectId,
				scope: "project",
			});
		}

		return requestId;
	},
});

export const list_deletion_request_ids_by_scope = internalQuery({
	args: {
		scope: app_convex_schema.tables.data_deletion_requests.validator.fields.scope,
		limit: v.number(),
		_test_now: v.optional(v.number()),
	},
	returns: v.array(v.id("data_deletion_requests")),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const cutoff = now - RETENTION_MS;
		const ids: Array<Id<"data_deletion_requests">> = [];

		for await (const row of ctx.db
			.query("data_deletion_requests")
			.withIndex("by_creation_time", (q) => q.lte("_creationTime", cutoff))
			.order("asc")) {
			if (row.scope !== args.scope) {
				continue;
			}

			ids.push(row._id);
			if (ids.length >= args.limit) {
				break;
			}
		}

		return ids;
	},
});

export const process_user_deletion_request = internalMutation({
	args: {
		requestId: v.id("data_deletion_requests"),
		/**
		 * Internal simulated wall time (ms) used by tests to bypass retention.
		 *
		 * Omit in normal production flows (`Date.now()` is used).
		 */
		_test_now: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const request = await ctx.db.get("data_deletion_requests", args.requestId);
		if (!request) {
			return null;
		}

		if (request.scope !== "user") {
			return null;
		}

		const user = await ctx.db.get("users", request.userId);
		if (!user) {
			await ctx.db.delete("data_deletion_requests", request._id);
			return null;
		}

		const retentionDeadline = request._creationTime + RETENTION_MS;
		if (now < retentionDeadline) {
			return null;
		}

		if (user.deletedAt == null) {
			return null;
		}

		// Finalize the user first to delete the remaining user-owned rows and to
		// compute which workspaces became fully empty at the retention boundary.
		const deleteUserRes = await db_finalize_deleted_user(ctx, {
			userId: user._id,
			now: now,
		});

		if (deleteUserRes?.workspacesToDelete) {
			// Delete whole workspaces here, not individual projects, because by
			// this point these workspaces have no active members left and should be
			// torn down in one pass. Clear the matching workspace/project request
			// rows here too, because `db_delete_workspace` only purges data and
			// returns the exact targets it consumed.
			for (const workspace of deleteUserRes.workspacesToDelete) {
				const { projectRequestsToDelete } = await db_delete_workspace(ctx, {
					workspaceId: workspace.workspaceId,
				});

				await Promise.all([
					db_delete_data_deletion_requests(ctx, {
						scope: "workspace",
						workspaceId: workspace.workspaceId,
					}),
					...projectRequestsToDelete.map((projectRequest) =>
						db_delete_data_deletion_requests(ctx, {
							scope: "project",
							workspaceId: projectRequest.workspaceId,
							projectId: projectRequest.projectId,
						}),
					),
				]);
			}
		}

		await ctx.db.delete("data_deletion_requests", request._id);

		return null;
	},
});

/**
 * Process one queued workspace-scope deletion whose retention window has passed.
 */
export const process_workspace_deletion_request = internalMutation({
	args: {
		requestId: v.id("data_deletion_requests"),
		/**
		 * Internal simulated wall time (ms) used by tests to bypass retention.
		 *
		 * Omit in normal production and cron flows (`Date.now()` is used).
		 *
		 * Pass a value past the retention window (e.g. `_creationTime + RETENTION_MS + 1`)
		 * so purge eligibility runs in one step without waiting.
		 */
		_test_now: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const request = await ctx.db.get("data_deletion_requests", args.requestId);
		if (!request) {
			return null;
		}

		if (request.scope !== "workspace") {
			return null;
		}

		const retentionDeadline = request._creationTime + RETENTION_MS;
		if (now < retentionDeadline) {
			return null;
		}

		if (!request.workspaceId) {
			await ctx.db.delete("data_deletion_requests", request._id);
			return null;
		}

		const { projectRequestsToDelete } = await db_delete_workspace(ctx, {
			workspaceId: request.workspaceId,
		});

		// Clear the matching queued project requests here too, because deleting
		// the whole workspace already consumed those project purge targets.
		await Promise.all(
			projectRequestsToDelete.map((projectRequest) =>
				db_delete_data_deletion_requests(ctx, {
					scope: "project",
					workspaceId: projectRequest.workspaceId,
					projectId: projectRequest.projectId,
				}),
			),
		);

		await ctx.db.delete("data_deletion_requests", request._id);

		return null;
	},
});

/**
 * Process one queued project-scope deletion whose retention window has passed.
 */
export const process_project_deletion_request = internalMutation({
	args: {
		requestId: v.id("data_deletion_requests"),
		/**
		 * Internal simulated wall time (ms) used by tests to bypass retention.
		 *
		 * Omit in normal production and cron flows (`Date.now()` is used).
		 *
		 * Pass a value past the retention window (e.g. `_creationTime + RETENTION_MS + 1`)
		 * so purge eligibility runs in one step without waiting.
		 */
		_test_now: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const request = await ctx.db.get("data_deletion_requests", args.requestId);
		if (!request) {
			return null;
		}

		if (request.scope !== "project") {
			return null;
		}

		const retentionDeadline = request._creationTime + RETENTION_MS;
		if (now < retentionDeadline) {
			return null;
		}

		if (!request.workspaceId || !request.projectId) {
			await ctx.db.delete("data_deletion_requests", request._id);
			return null;
		}

		await db_purge_workspace_project_content(ctx, {
			workspaceId: request.workspaceId,
			projectId: request.projectId,
		});

		await ctx.db.delete("data_deletion_requests", request._id);

		return null;
	},
});

export const hard_delete_user_data = internalMutation({
	args: {
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const user = await ctx.db.get("users", args.userId);
		if (!user) {
			return null;
		}

		const now = Date.now();

		// Run the same phase-1 tombstone and orphan discovery inline because the
		// admin hard-delete path does not wait for the delayed request pipeline.
		const projectsToDelete = await db_prepare_user_for_deletion(ctx, {
			user,
			now: now,
		});

		// Delete these projects one-by-one here because their workspaces are
		// still alive for other members; only the projects themselves became
		// orphaned during phase 1. Clear any matching queued project request too
		// so this direct path does not leave delayed follow-up work behind.
		for (const project of projectsToDelete) {
			await db_purge_workspace_project_content(ctx, {
				workspaceId: project.workspaceId,
				projectId: project.projectId,
			});

			await db_delete_data_deletion_requests(ctx, {
				scope: "project",
				workspaceId: project.workspaceId,
				projectId: project.projectId,
			});
		}

		// Drain any orphan project requests left by an earlier scheduled phase-1
		// run. Those projects already lost their shell rows, so phase-1 discovery
		// cannot find them again from memberships, but their content still needs
		// to be purged before the admin hard delete finishes.
		const queuedProjectRequests = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_userId", (q) => q.eq("userId", user._id))
			.collect();

		for (const request of queuedProjectRequests) {
			if (request.scope !== "project" || !request.workspaceId || !request.projectId) {
				continue;
			}

			const projectStillExists = await ctx.db.get("workspaces_projects", request.projectId);
			if (projectStillExists) {
				continue;
			}

			await db_purge_workspace_project_content(ctx, {
				workspaceId: request.workspaceId,
				projectId: request.projectId,
			});

			await db_delete_data_deletion_requests(ctx, {
				scope: "project",
				workspaceId: request.workspaceId,
				projectId: request.projectId,
			});
		}

		// Finalize the user only after the phase-1 project split above, then use
		// the remaining empty workspaces as the full-workspace teardown targets.
		const deleteUserRes = await db_finalize_deleted_user(ctx, {
			userId: user._id,
			now: now,
		});

		if (deleteUserRes?.workspacesToDelete) {
			// Delete whole workspaces here, not individual projects, because these
			// workspaces now have no active members left at all. Clear the matching
			// workspace/project request rows here too, because `db_delete_workspace`
			// only purges data and returns the exact targets it consumed.
			for (const workspace of deleteUserRes.workspacesToDelete) {
				const { projectRequestsToDelete } = await db_delete_workspace(ctx, {
					workspaceId: workspace.workspaceId,
				});

				await Promise.all([
					db_delete_data_deletion_requests(ctx, {
						scope: "workspace",
						workspaceId: workspace.workspaceId,
					}),
					...projectRequestsToDelete.map((projectRequest) =>
						db_delete_data_deletion_requests(ctx, {
							scope: "project",
							workspaceId: projectRequest.workspaceId,
							projectId: projectRequest.projectId,
						}),
					),
				]);
			}
		}

		await db_delete_data_deletion_requests(ctx, {
			scope: "user",
			userId: user._id,
		});

		return null;
	},
});

export const process_deletion_requests = internalAction({
	args: {
		/**
		 * Internal simulated wall time (ms) for listing and per-request mutations used by tests.
		 *
		 * Omit in normal production flows (`Date.now()` is used via optional chaining at each call site).
		 */
		_test_now: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const test_now = args._test_now;

		const userRequestIds: Id<"data_deletion_requests">[] = await ctx.runQuery(
			internal.data_deletion.list_deletion_request_ids_by_scope,
			{ scope: "user", limit: USER_DELETION_REQUEST_BATCH_SIZE, _test_now: test_now },
		);

		for (const requestId of userRequestIds) {
			try {
				await ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
					requestId,
					_test_now: test_now,
				});
			} catch (error) {
				console.error("[data_deletion.process_deletion_requests] Failed to process user deletion request", {
					error,
					requestId,
				});
			}
		}

		const workspaceRequestIds: Id<"data_deletion_requests">[] = await ctx.runQuery(
			internal.data_deletion.list_deletion_request_ids_by_scope,
			{
				scope: "workspace",
				limit: WORKSPACE_DELETION_REQUEST_BATCH_SIZE,
				_test_now: test_now,
			},
		);

		for (const requestId of workspaceRequestIds) {
			try {
				await ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
					requestId,
					_test_now: test_now,
				});
			} catch (error) {
				console.error("[data_deletion.process_deletion_requests] Failed to process workspace deletion request", {
					error,
					requestId,
				});
			}
		}

		const projectRequestIds: Id<"data_deletion_requests">[] = await ctx.runQuery(
			internal.data_deletion.list_deletion_request_ids_by_scope,
			{ scope: "project", limit: PROJECT_DELETION_REQUEST_BATCH_SIZE, _test_now: test_now },
		);

		for (const requestId of projectRequestIds) {
			try {
				await ctx.runMutation(internal.data_deletion.process_project_deletion_request, {
					requestId,
					_test_now: test_now,
				});
			} catch (error) {
				console.error("[data_deletion.process_deletion_requests] Failed to process project deletion request", {
					error,
					requestId,
				});
			}
		}

		return null;
	},
});
