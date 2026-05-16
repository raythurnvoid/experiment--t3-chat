import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import app_convex_schema from "./schema.ts";
import { data_deletion_db_request } from "../server/data_deletion.ts";
import { presence } from "./presence.ts";
import { workspaces_db_ensure_default_workspace_and_project_for_user } from "./workspaces.ts";
import { quotas_db_get } from "./quotas.ts";

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

	// files_pending_updates (tenant docs + cleanup tasks + file ids used to locate `files_yjs_snapshot_schedules` docs)
	const pendingUpdateIds: Array<Id<"files_pending_updates">> = [];
	for await (const doc of ctx.db.query("files_pending_updates")) {
		if (doc.workspaceId === workspaceId && doc.projectId === projectId) {
			pendingUpdateIds.push(doc._id);
		}
	}

	const pendingUpdateCleanupTaskIds: Array<Id<"files_pending_updates_cleanup_tasks">> = [];
	for (const pendingUpdateId of pendingUpdateIds) {
		const task = await ctx.db
			.query("files_pending_updates_cleanup_tasks")
			.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", pendingUpdateId))
			.first();
		if (task) {
			pendingUpdateCleanupTaskIds.push(task._id);
		}
	}

	const nodeIds: Array<Id<"files_nodes">> = [];
	for await (const page of ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_parent_name", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		nodeIds.push(page._id);
	}

	const filesR2AssetIds: Array<Id<"files_r2_assets">> = [];
	for await (const doc of ctx.db
		.query("files_r2_assets")
		.withIndex("by_workspace_project_r2Key", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))) {
		filesR2AssetIds.push(doc._id);
	}

	const filesUploadIds: Array<Id<"files_uploads">> = [];
	for await (const doc of ctx.db.query("files_uploads")) {
		if (doc.workspaceId === workspaceId && doc.projectId === projectId) {
			filesUploadIds.push(doc._id);
		}
	}

	const filesYjsSnapshotScheduleIds: Array<Id<"files_yjs_snapshot_schedules">> = [];
	for (const nodeId of nodeIds) {
		const sched = await ctx.db
			.query("files_yjs_snapshot_schedules")
			.withIndex("by_file", (q) => q.eq("nodeId", nodeId))
			.first();
		if (sched) {
			filesYjsSnapshotScheduleIds.push(sched._id);
		}
	}

	// ai_chat_threads_messages_aisdk_5
	const aiChatThreadsMessagesAisdk5Ids: Array<Id<"ai_chat_threads_messages_aisdk_5">> = [];
	for await (const doc of ctx.db
		.query("ai_chat_threads_messages_aisdk_5")
		.withIndex("by_workspace_project_thread", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))) {
		aiChatThreadsMessagesAisdk5Ids.push(doc._id);
	}

	// ai_chat_threads
	const aiChatThreadsIds: Array<Id<"ai_chat_threads">> = [];
	for await (const doc of ctx.db
		.query("ai_chat_threads")
		.withIndex("by_workspace_project_archived_lastMessageAt", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		aiChatThreadsIds.push(doc._id);
	}

	// chat_messages
	const chatMessagesIds: Array<Id<"chat_messages">> = [];
	for await (const doc of ctx.db
		.query("chat_messages")
		.withIndex("by_workspace_project_thread", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))) {
		chatMessagesIds.push(doc._id);
	}

	// files_pending_updates_last_sequence_saved (full table scan; filter in memory)
	const filesPendingUpdatesLastSequenceSavedIds: Array<Id<"files_pending_updates_last_sequence_saved">> = [];
	for await (const doc of ctx.db.query("files_pending_updates_last_sequence_saved")) {
		if (doc.workspaceId === workspaceId && doc.projectId === projectId) {
			filesPendingUpdatesLastSequenceSavedIds.push(doc._id);
		}
	}

	// files_plain_text_chunks
	const filesPlainTextChunksIds: Array<Id<"files_plain_text_chunks">> = [];
	for await (const doc of ctx.db
		.query("files_plain_text_chunks")
		.withIndex("by_workspace_project_file_yjsSequence_chunkIndex", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		filesPlainTextChunksIds.push(doc._id);
	}

	// files_markdown_chunks
	const filesMarkdownChunksIds: Array<Id<"files_markdown_chunks">> = [];
	for await (const doc of ctx.db
		.query("files_markdown_chunks")
		.withIndex("by_workspace_project_file_yjsSequence_chunkIndex", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		filesMarkdownChunksIds.push(doc._id);
	}

	// files_yjs_snapshots
	const filesYjsSnapshotsIds: Array<Id<"files_yjs_snapshots">> = [];
	for await (const doc of ctx.db
		.query("files_yjs_snapshots")
		.withIndex("by_workspace_project_file_sequence", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		filesYjsSnapshotsIds.push(doc._id);
	}

	// files_yjs_updates
	const filesYjsUpdatesIds: Array<Id<"files_yjs_updates">> = [];
	for await (const doc of ctx.db
		.query("files_yjs_updates")
		.withIndex("by_workspace_project_file_sequence", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		filesYjsUpdatesIds.push(doc._id);
	}

	// files_yjs_docs_last_sequences
	const filesYjsDocsLastSequencesIds: Array<Id<"files_yjs_docs_last_sequences">> = [];
	for await (const doc of ctx.db
		.query("files_yjs_docs_last_sequences")
		.withIndex("by_workspace_project_file", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))) {
		filesYjsDocsLastSequencesIds.push(doc._id);
	}

	// files_snapshots_contents
	const filesSnapshotsContentsIds: Array<Id<"files_snapshots_contents">> = [];
	for await (const doc of ctx.db
		.query("files_snapshots_contents")
		.withIndex("by_workspace_project_fileSnapshot", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		filesSnapshotsContentsIds.push(doc._id);
	}

	// files_snapshots
	const filesSnapshotsIds: Array<Id<"files_snapshots">> = [];
	for await (const doc of ctx.db
		.query("files_snapshots")
		.withIndex("by_workspace_project_file_archivedAt", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		filesSnapshotsIds.push(doc._id);
	}

	// files_markdown_content (full table scan)
	const filesMarkdownContentIds: Array<Id<"files_markdown_content">> = [];
	for await (const doc of ctx.db.query("files_markdown_content")) {
		if (doc.workspaceId === workspaceId && doc.projectId === projectId) {
			filesMarkdownContentIds.push(doc._id);
		}
	}

	// --- delete (same dependency order as before) ---

	// files_pending_updates_cleanup_tasks
	await Promise.all(pendingUpdateCleanupTaskIds.map((id) => ctx.db.delete("files_pending_updates_cleanup_tasks", id)));
	// files_yjs_snapshot_schedules
	await Promise.all(filesYjsSnapshotScheduleIds.map((id) => ctx.db.delete("files_yjs_snapshot_schedules", id)));
	// ai_chat_threads_messages_aisdk_5
	await Promise.all(aiChatThreadsMessagesAisdk5Ids.map((id) => ctx.db.delete("ai_chat_threads_messages_aisdk_5", id)));
	// ai_chat_threads
	await Promise.all(aiChatThreadsIds.map((id) => ctx.db.delete("ai_chat_threads", id)));
	// chat_messages
	await Promise.all(chatMessagesIds.map((id) => ctx.db.delete("chat_messages", id)));
	// files_pending_updates_last_sequence_saved
	await Promise.all(
		filesPendingUpdatesLastSequenceSavedIds.map((id) => ctx.db.delete("files_pending_updates_last_sequence_saved", id)),
	);
	// files_pending_updates
	await Promise.all(pendingUpdateIds.map((id) => ctx.db.delete("files_pending_updates", id)));
	// files_plain_text_chunks
	await Promise.all(filesPlainTextChunksIds.map((id) => ctx.db.delete("files_plain_text_chunks", id)));
	// files_markdown_chunks
	await Promise.all(filesMarkdownChunksIds.map((id) => ctx.db.delete("files_markdown_chunks", id)));
	// files_yjs_snapshots
	await Promise.all(filesYjsSnapshotsIds.map((id) => ctx.db.delete("files_yjs_snapshots", id)));
	// files_yjs_updates
	await Promise.all(filesYjsUpdatesIds.map((id) => ctx.db.delete("files_yjs_updates", id)));
	// files_yjs_docs_last_sequences
	await Promise.all(filesYjsDocsLastSequencesIds.map((id) => ctx.db.delete("files_yjs_docs_last_sequences", id)));
	// files_snapshots_contents
	await Promise.all(filesSnapshotsContentsIds.map((id) => ctx.db.delete("files_snapshots_contents", id)));
	// files_snapshots
	await Promise.all(filesSnapshotsIds.map((id) => ctx.db.delete("files_snapshots", id)));
	// files_markdown_content
	await Promise.all(filesMarkdownContentIds.map((id) => ctx.db.delete("files_markdown_content", id)));
	// files_r2_assets
	await Promise.all(filesR2AssetIds.map((id) => ctx.db.delete("files_r2_assets", id)));
	// files_uploads
	await Promise.all(filesUploadIds.map((id) => ctx.db.delete("files_uploads", id)));
	// files
	await Promise.all(nodeIds.map((id) => ctx.db.delete("files_nodes", id)));
}

async function db_delete_data_deletion_requests(
	ctx: MutationCtx,
	args:
		| { scope: "user"; userId: Id<"users"> }
		| { scope: "workspace"; workspaceId: Id<"workspaces"> }
		| { scope: "project"; workspaceId: Id<"workspaces">; projectId: Id<"workspaces_projects"> },
) {
	if (args.scope === "user") {
		const docs = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect();

		await Promise.all(
			docs.filter((doc) => doc.scope === "user").map((doc) => ctx.db.delete("data_deletion_requests", doc._id)),
		);

		return;
	}

	const docs = await ctx.db
		.query("data_deletion_requests")
		.withIndex(
			"by_workspace_project",
			args.scope === "project"
				? (q) => q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId)
				: (q) => q.eq("workspaceId", args.workspaceId),
		)
		.collect();

	await Promise.all(
		docs
			.filter((doc) =>
				args.scope === "project" ? doc.scope === "project" : doc.scope === "workspace" && doc.projectId === undefined,
			)
			.map((doc) => ctx.db.delete("data_deletion_requests", doc._id)),
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

	await Promise.all([
		ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspace_default", (q) => q.eq("workspaceId", args.workspaceId))
			.collect()
			.then((remainingProjects) =>
				Promise.all(remainingProjects.map((project) => ctx.db.delete("workspaces_projects", project._id))),
			),
		ctx.db
			.query("quotas")
			.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", args.workspaceId))
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("quotas", doc._id)))),
		ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_workspace_project_user_role", (q) => q.eq("workspaceId", args.workspaceId))
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)))),
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_workspace_project_resource_user_permission", (q) => q.eq("workspaceId", args.workspaceId))
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)))),
	]);

	await ctx.db.delete("workspaces", args.workspaceId);

	return {
		projectRequestsToDelete,
	};
}

async function db_queue_workspace_deletion_for_owner_account_deletion(
	ctx: MutationCtx,
	args: {
		workspaceOwnerUserId: Id<"users">;
		workspace: Doc<"workspaces">;
		now: number;
	},
) {
	const [, , , userIdsPerProject] = await Promise.all([
		data_deletion_db_request(ctx, {
			userId: args.workspaceOwnerUserId,
			workspaceId: args.workspace._id,
			scope: "workspace",
		}),
		ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_workspace_project_user_role", (q) => q.eq("workspaceId", args.workspace._id))
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)))),
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_workspace_project_resource_user_permission", (q) => q.eq("workspaceId", args.workspace._id))
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)))),
		ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspace_default", (q) => q.eq("workspaceId", args.workspace._id))
			.collect()
			.then((workspaceProjects) =>
				Promise.all(
					workspaceProjects.map(async (project) => {
						const projectUsers = await ctx.db
							.query("workspaces_projects_users")
							.withIndex("by_project_user_active", (q) => q.eq("projectId", project._id))
							.collect();

						await Promise.all(
							projectUsers.map((projectUser) => ctx.db.delete("workspaces_projects_users", projectUser._id)),
						);

						return projectUsers.map((projectUser) => projectUser.userId);
					}),
				),
			),
	]);

	const quota = await quotas_db_get(ctx, {
		quotaName: "extra_workspaces",
		userId: args.workspaceOwnerUserId,
	});
	if (quota.usedCount > 0) {
		await ctx.db.patch("quotas", quota._id, {
			usedCount: quota.usedCount - 1,
			updatedAt: args.now,
		});
	}

	for (const userId of new Set<Id<"users">>(userIdsPerProject.flat())) {
		await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
			userId,
			now: args.now,
		});
	}
}

async function db_prepare_user_for_deletion(
	ctx: MutationCtx,
	args: {
		user: Doc<"users">;
		now: number;
	},
) {
	const memberships = await ctx.db
		.query("workspaces_projects_users")
		.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", args.user._id))
		.collect();

	if (args.user.deletedAt == null) {
		// Tombstone the user and deactivate memberships so phase 1 stays
		// reversible while phase 2 still has the affected tenants available.
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

	// Drop presence docs for the deleted user so no orphan docs linger;
	// `list` / `listRoom` already filter silently if anything is re-created.
	const presenceRooms = await presence.listUser(ctx, args.user._id, false, 10_000);
	await Promise.all(presenceRooms.map((room) => presence.removeRoomUser(ctx, room.roomId, args.user._id)));
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
	const [
		membershipsAll,
		accessRoleAssignments,
		anonymousAuthTokens,
		pendingUpdates,
		lastSequenceSaved,
		billingUsageSnapshots,
	] = await Promise.all([
		ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", user._id))
			.collect(),
		ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_user_role_workspace_project", (q) => q.eq("userId", user._id))
			.collect(),
		ctx.db
			.query("users_anon_tokens")
			.withIndex("by_user", (q) => q.eq("userId", user._id))
			.collect(),
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_page", (q) => q.eq("userId", userIdString))
			.collect(),
		ctx.db
			.query("files_pending_updates_last_sequence_saved")
			.withIndex("by_user_page", (q) => q.eq("userId", userIdString))
			.collect(),
		ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_user", (q) => q.eq("userId", user._id))
			.collect(),
	]);

	const pendingUpdateCleanupTasks = (
		await Promise.all(
			pendingUpdates.map((doc) =>
				ctx.db
					.query("files_pending_updates_cleanup_tasks")
					.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", doc._id))
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
	for (const assignment of accessRoleAssignments) {
		affectedWorkspaceIds.add(assignment.workspaceId);
	}

	await Promise.all(pendingUpdateCleanupTasks.map((doc) => ctx.db.delete("files_pending_updates_cleanup_tasks", doc._id)));
	await Promise.all(lastSequenceSaved.map((doc) => ctx.db.delete("files_pending_updates_last_sequence_saved", doc._id)));
	await Promise.all(pendingUpdates.map((doc) => ctx.db.delete("files_pending_updates", doc._id)));
	await Promise.all(membershipsAll.map((doc) => ctx.db.delete("workspaces_projects_users", doc._id)));
	await Promise.all(accessRoleAssignments.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)));
	await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_user_workspace_project_resource_permission", (q) => q.eq("userId", user._id))
		.collect()
		.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id))));
	await Promise.all(anonymousAuthTokens.map((doc) => ctx.db.delete("users_anon_tokens", doc._id)));
	await ctx.db
		.query("quotas")
		.withIndex("by_user_quotaName", (q) => q.eq("userId", user._id))
		.collect()
		.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("quotas", doc._id))));
	await Promise.all(billingUsageSnapshots.map((doc) => ctx.db.delete("billing_usage_snapshots", doc._id)));

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
		const ownedWorkspaces = await ctx.db
			.query("workspaces")
			.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", args.userId))
			.collect();

		for (const workspace of ownedWorkspaces.filter((workspace) => !workspace.default)) {
			await db_queue_workspace_deletion_for_owner_account_deletion(ctx, {
				workspaceOwnerUserId: user._id,
				workspace,
				now,
			});
		}

		// Keep phase 1 reversible for the account itself. Owned workspaces that
		// remain after any frontend transfer calls are queued for deletion here,
		// so restoring the account does not recover those workspace deletions.
		await db_prepare_user_for_deletion(ctx, {
			user,
			now,
		});

		const requestId = await data_deletion_db_request(ctx, {
			userId: args.userId,
			scope: "user",
		});

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

		for await (const doc of ctx.db
			.query("data_deletion_requests")
			.withIndex("by_creation_time", (q) => q.lte("_creationTime", cutoff))
			.order("asc")) {
			if (doc.scope !== args.scope) {
				continue;
			}

			ids.push(doc._id);
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
			// The user shell can be purged manually or by an admin path before the
			// queued request runs. Still clear quota docs from the request's user id.
			await Promise.all([
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) => q.eq("userId", request.userId))
					.collect()
					.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("quotas", doc._id)))),
				ctx.db.delete("data_deletion_requests", request._id),
			]);
			return null;
		}

		const retentionDeadline = request._creationTime + RETENTION_MS;
		if (now < retentionDeadline) {
			return null;
		}

		if (user.deletedAt == null) {
			return null;
		}

		// Finalize the user first to delete the remaining user-owned docs and to
		// compute which workspaces became fully empty at the retention boundary.
		const deleteUserRes = await db_finalize_deleted_user(ctx, {
			userId: user._id,
			now: now,
		});

		if (deleteUserRes?.workspacesToDelete) {
			// Delete whole workspaces here, not individual projects, because by
			// this point these workspaces have no active members left and should be
			// torn down in one pass. Clear the matching workspace/project request
			// docs here too, because `db_delete_workspace` only purges data and
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

		const workspaceId = request.workspaceId;
		if (!workspaceId) {
			await ctx.db.delete("data_deletion_requests", request._id);
			return null;
		}

		const { projectRequestsToDelete } = await db_delete_workspace(ctx, {
			workspaceId,
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

		// Run the reversible phase-1 tombstone inline because the admin path
		// does not wait for the delayed user deletion request.
		await db_prepare_user_for_deletion(ctx, {
			user,
			now: now,
		});
		const deleteUserRes = await db_finalize_deleted_user(ctx, {
			userId: user._id,
			now: now,
		});

		if (deleteUserRes?.workspacesToDelete) {
			// Delete whole workspaces here, not individual projects, because these
			// workspaces now have no active members left at all. Clear the matching
			// workspace/project request docs here too, because `db_delete_workspace`
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
				console.error("Failed to process user deletion request", {
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
				console.error("Failed to process workspace deletion request", {
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
				console.error("Failed to process project deletion request", {
					error,
					requestId,
				});
			}
		}

		return null;
	},
});
