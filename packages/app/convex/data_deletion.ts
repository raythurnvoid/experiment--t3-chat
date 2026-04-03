import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import app_convex_schema from "./schema.ts";
import { workspaces_db_ensure_default_workspace_and_project_for_user } from "../server/workspaces.ts";
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

export const init_user_deletion = internalMutation({
	args: {
		userId: v.id("users"),
		nowTs: v.optional(v.number()),
	},
	returns: v.id("data_deletion_requests"),
	handler: async (ctx, args) => {
		const now = args.nowTs ?? Date.now();
		const requestId = await data_deletion_db_request(ctx, {
			userId: args.userId,
			scope: "user",
		});

		const user = await ctx.db.get("users", args.userId);
		if (!user || user.deletedAt != null) {
			return requestId;
		}

		const memberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", user._id))
			.collect();

		// Soft-delete the user immediately and deactivate their memberships during retention.
		await Promise.all(
			memberships.map((m) =>
				ctx.db.patch("workspaces_projects_users", m._id, {
					active: false,
					updatedAt: now,
				}),
			),
		);

		await ctx.db.patch("users", user._id, {
			deletedAt: now,
		});

		const candidateProjectWorkspaceIds = new Map(memberships.map((m) => [m.projectId, m.workspaceId]));
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
				.withIndex("by_active_workspace_project_user", (q) =>
					q.eq("active", true).eq("workspaceId", project.workspaceId),
				)
				.first();
			if (!activeMemberStillInWorkspace) {
				continue;
			}

			if (project.default) {
				continue;
			}

			// Remove non-default projects that became empty, but keep shared workspaces intact.
			// Queue the delayed project-content purge before you remove the project doc.
			// Keep the workspace itself because it still has active members elsewhere.
			// After removing project memberships and the project doc, repair default
			// workspace/project pointers for every user that was attached to this project.
			const workspace = await ctx.db.get("workspaces", project.workspaceId);
			if (!workspace) {
				continue;
			}

			const projectUserLookup = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_project_user_active", (q) => q.eq("projectId", projectId))
				.collect();

			await data_deletion_db_request(ctx, {
				userId: user._id,
				workspaceId: workspace._id,
				projectId: project._id,
				scope: "project",
			});

			const limitDefinition = workspace_limits.EXTRA_PROJECTS;
			const limit = await ctx.db
				.query("limits_per_workspace")
				.withIndex("by_workspace_limit", (q) =>
					q.eq("workspaceId", workspace._id).eq("limitName", limitDefinition.name),
				)
				.first();

			if (limit && limit.usedCount > 0) {
				await ctx.db.patch("limits_per_workspace", limit._id, {
					usedCount: limit.usedCount - 1,
					updatedAt: now,
				});
			}

			await Promise.all(
				projectUserLookup.map((projectUser) => ctx.db.delete("workspaces_projects_users", projectUser._id)),
			);

			await ctx.db.delete("workspaces_projects", project._id);

			for (const user_id of new Set(projectUserLookup.map((projectUser) => projectUser.userId))) {
				await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
					userId: user_id,
					now,
				});
			}
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
		 * Convex tests only: simulated wall time (ms). Omit in production (`Date.now()` is used).
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

		const affectedWorkspaceIds = new Set<Id<"workspaces">>();
		if (user.defaultWorkspaceId) {
			affectedWorkspaceIds.add(user.defaultWorkspaceId);
		}
		for (const membership of membershipsAll) {
			affectedWorkspaceIds.add(membership.workspaceId);
		}

		// Hard-delete user-owned docs after the retention window has passed.
		await Promise.all(
			pendingEditCleanupTasks.map((row) => ctx.db.delete("pages_pending_edits_cleanup_tasks", row._id)),
		);
		await Promise.all(
			lastSequenceSaved.map((row) => ctx.db.delete("pages_pending_edits_last_sequence_saved", row._id)),
		);
		await Promise.all(pendingEdits.map((row) => ctx.db.delete("pages_pending_edits", row._id)));
		await Promise.all(membershipsAll.map((row) => ctx.db.delete("workspaces_projects_users", row._id)));
		await Promise.all(anonymousAuthTokens.map((row) => ctx.db.delete("users_anon_tokens", row._id)));
		await Promise.all(userLimits.map((row) => ctx.db.delete("limits_per_user", row._id)));

		await ctx.db.patch("users", user._id, {
			clerkUserId: null,
			anonymousAuthToken: undefined,
			defaultWorkspaceId: undefined,
			defaultProjectId: undefined,
			deletedAt: user.deletedAt ?? now,
		});

		// Remove workspaces that no longer have any active memberships after this user is fully deleted.
		for (const workspaceId of affectedWorkspaceIds) {
			// Queue delayed project-content purges for every project in this workspace.
			// Once the workspace has no active memberships left, remove its limits,
			// its project docs, and the workspace doc itself.
			const workspace = await ctx.db.get("workspaces", workspaceId);
			if (!workspace) {
				continue;
			}

			const remainingMemberships = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_workspace_project_user", (q) =>
					q.eq("active", true).eq("workspaceId", workspaceId),
				)
				.first();
			if (remainingMemberships) {
				continue;
			}

			const [projects, workspaceLimits] = await Promise.all([
				ctx.db
					.query("workspaces_projects")
					.withIndex("by_workspace_default", (q) => q.eq("workspaceId", workspaceId))
					.collect(),
				ctx.db
					.query("limits_per_workspace")
					.withIndex("by_workspace_limit", (q) => q.eq("workspaceId", workspaceId))
					.collect(),
			]);

			for (const project of projects) {
				await data_deletion_db_request(ctx, {
					userId: user._id,
					workspaceId,
					projectId: project._id,
					scope: "project",
				});
			}

			await Promise.all(workspaceLimits.map((row) => ctx.db.delete("limits_per_workspace", row._id)));
			await Promise.all(projects.map((row) => ctx.db.delete("workspaces_projects", row._id)));
			await ctx.db.delete("workspaces", workspaceId);
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
		 * Convex tests only: simulated wall time (ms). Omit in production and cron (`Date.now()` is used).
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

		const workspaceId = request.workspaceId;
		const projects = await ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspace_default", (q) => q.eq("workspaceId", workspaceId))
			.collect();
		const projectIdsToPurge = projects.map((p) => p._id);

		// Purge heavy project-scoped content before you remove structural workspace docs.
		if (projectIdsToPurge.length) {
			for (const projectId of projectIdsToPurge) {
				await db_purge_workspace_project_content(ctx, { workspaceId, projectId });
			}
		}

		// Remove the remaining workspace structure after every project purge finishes.
		const workspaceStill = await ctx.db.get("workspaces", workspaceId);
		if (workspaceStill) {
			const remainingProjects = await ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspace_default", (q) => q.eq("workspaceId", workspaceId))
				.collect();
			await Promise.all(remainingProjects.map((project) => ctx.db.delete("workspaces_projects", project._id)));

			const limitsPerWorkspaceDocs = await ctx.db
				.query("limits_per_workspace")
				.withIndex("by_workspace_limit", (q) => q.eq("workspaceId", workspaceId))
				.collect();
			await Promise.all(limitsPerWorkspaceDocs.map((doc) => ctx.db.delete("limits_per_workspace", doc._id)));

			await ctx.db.delete("workspaces", workspaceId);
		}

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
		 * Convex tests only: simulated wall time (ms). Omit in production and cron (`Date.now()` is used).
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

export const process_deletion_requests = internalAction({
	args: {
		/**
		 * Convex tests only: simulated wall time (ms) for listing and per-request mutations.
		 * Omit in production (`Date.now()` is used via optional chaining at each call site).
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
