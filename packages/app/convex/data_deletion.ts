import { v } from "convex/values";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import app_convex_schema from "./schema.ts";
import { data_deletion_db_request } from "../server/data_deletion.ts";
import { presence } from "./presence.ts";
import {
	workspaces_db_create,
	workspaces_db_ensure_default_workspace_and_project_for_user,
} from "./workspaces.ts";
import { quotas_db_ensure, quotas_db_get } from "./quotas.ts";
import { r2_delete_object } from "./r2.ts";
import { workspaces_DEFAULT_WORKSPACE_NAME } from "../shared/workspaces.ts";
import { convex_error } from "../server/convex-utils.ts";
import {
	access_control_project_role_permission_grants,
	access_control_db_ensure_role_assignment,
	access_control_db_ensure_role_permission_grant,
	access_control_workspace_role_permission_grants,
} from "./access_control.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const USER_DELETION_REQUEST_BATCH_SIZE = 20;
const WORKSPACE_DELETION_REQUEST_BATCH_SIZE = 50;
const PROJECT_DELETION_REQUEST_BATCH_SIZE = 200;

const files_content_materialization_workpool = new Workpool(components.files_content_materialization_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

const files_upload_conversion_workpool = new Workpool(components.files_upload_conversion_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

async function db_purge_workspace_project_content(
	ctx: MutationCtx,
	args: { workspaceId: Id<"workspaces">; projectId: Id<"workspaces_projects"> },
) {
	const { workspaceId, projectId } = args;

	// --- collect ids (read everything first; see TODO on purge for large-tenant limits) ---

	// files_pending_updates (tenant docs + cleanup tasks + file ids used to locate file-scoped background jobs)
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

	const pendingUpdateChunkIds: Array<Id<"files_pending_updates_chunks">> = [];
	for (const pendingUpdateId of pendingUpdateIds) {
		const chunks = await ctx.db
			.query("files_pending_updates_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", pendingUpdateId))
			.collect();
		pendingUpdateChunkIds.push(...chunks.map((chunk) => chunk._id));
	}

	const nodeIds: Array<Id<"files_nodes">> = [];
	for await (const page of ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_parent_name_archiveOperation", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		nodeIds.push(page._id);
	}

	const filesR2AssetIds: Array<Id<"files_r2_assets">> = [];
	const filesR2AssetKeys: string[] = [];
	const filesUploadConversionJobs: Array<WorkId> = [];
	for await (const doc of ctx.db
		.query("files_r2_assets")
		.withIndex("by_workspace_project", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))) {
		filesR2AssetIds.push(doc._id);
		if (doc.r2Key) {
			filesR2AssetKeys.push(doc.r2Key);
		}
		if (doc.conversionWorkId) {
			filesUploadConversionJobs.push(doc.conversionWorkId);
		}
	}

	const filesContentMaterializationJobs: Array<{
		_id: Id<"files_content_materialization_jobs">;
		jobId: WorkId;
	}> = [];
	for (const nodeId of nodeIds) {
		const materializationJobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_file", (q) => q.eq("nodeId", nodeId))
			.collect();
		filesContentMaterializationJobs.push(...materializationJobs.map((job) => ({ _id: job._id, jobId: job.jobId })));
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

	// ai_chat_threads_state
	const aiChatThreadStateIds: Array<Id<"ai_chat_threads_state">> = [];
	for await (const doc of ctx.db
		.query("ai_chat_threads_state")
		.withIndex("by_workspace_project_thread", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))) {
		aiChatThreadStateIds.push(doc._id);
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

	// files_snapshots
	const filesSnapshotsIds: Array<Id<"files_snapshots">> = [];
	for await (const doc of ctx.db
		.query("files_snapshots")
		.withIndex("by_workspace_project_file_archivedAt", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)) {
		filesSnapshotsIds.push(doc._id);
	}

	// --- delete (same dependency order as before) ---

	// files_pending_updates_cleanup_tasks
	await Promise.all(pendingUpdateCleanupTaskIds.map((id) => ctx.db.delete("files_pending_updates_cleanup_tasks", id)));
	// files_content_materialization_jobs
	await Promise.all(
		filesContentMaterializationJobs.map((job) => files_content_materialization_workpool.cancel(ctx, job.jobId)),
	);
	await Promise.all(
		filesContentMaterializationJobs.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
	);
	// files upload conversion work
	await Promise.all(filesUploadConversionJobs.map((jobId) => files_upload_conversion_workpool.cancel(ctx, jobId)));
	// ai_chat_threads_messages_aisdk_5
	await Promise.all(aiChatThreadsMessagesAisdk5Ids.map((id) => ctx.db.delete("ai_chat_threads_messages_aisdk_5", id)));
	// ai_chat_threads_state
	await Promise.all(aiChatThreadStateIds.map((id) => ctx.db.delete("ai_chat_threads_state", id)));
	// ai_chat_threads
	await Promise.all(aiChatThreadsIds.map((id) => ctx.db.delete("ai_chat_threads", id)));
	// chat_messages
	await Promise.all(chatMessagesIds.map((id) => ctx.db.delete("chat_messages", id)));
	// files_pending_updates_last_sequence_saved
	await Promise.all(
		filesPendingUpdatesLastSequenceSavedIds.map((id) => ctx.db.delete("files_pending_updates_last_sequence_saved", id)),
	);
	// files_pending_updates_chunks
	await Promise.all(pendingUpdateChunkIds.map((id) => ctx.db.delete("files_pending_updates_chunks", id)));
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
	// files_snapshots
	await Promise.all(filesSnapshotsIds.map((id) => ctx.db.delete("files_snapshots", id)));
	// files_r2_assets
	await Promise.all(filesR2AssetKeys.map((key) => r2_delete_object(ctx, key)));
	await Promise.all(filesR2AssetIds.map((id) => ctx.db.delete("files_r2_assets", id)));
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
			.query("notifications")
			.withIndex("by_workspace_user_read", (q) => q.eq("workspaceId", args.workspaceId))
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("notifications", doc._id)))),
		Promise.all(
			projects.map((project) =>
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_project_user_active", (q) => q.eq("projectId", project._id))
					.collect()
					.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("workspaces_projects_users", doc._id)))),
			),
		),
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
		deleteUserAuth?: boolean;
		deleteBillingState?: boolean;
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
		args.deleteUserAuth
			? ctx.db
					.query("users_anon_tokens")
					.withIndex("by_user", (q) => q.eq("userId", user._id))
					.collect()
			: Promise.resolve([] as Array<Doc<"users_anon_tokens">>),
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_page", (q) => q.eq("userId", userIdString))
			.collect(),
		ctx.db
			.query("files_pending_updates_last_sequence_saved")
			.withIndex("by_user_page", (q) => q.eq("userId", userIdString))
			.collect(),
		args.deleteBillingState
			? ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", user._id))
					.collect()
			: Promise.resolve([] as Array<Doc<"billing_usage_snapshots">>),
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

	const pendingUpdateChunks = (
		await Promise.all(
			pendingUpdates.map((doc) =>
				ctx.db
					.query("files_pending_updates_chunks")
					.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", doc._id))
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

	await Promise.all(
		pendingUpdateCleanupTasks.map((doc) => ctx.db.delete("files_pending_updates_cleanup_tasks", doc._id)),
	);
	await Promise.all(pendingUpdateChunks.map((doc) => ctx.db.delete("files_pending_updates_chunks", doc._id)));
	await Promise.all(
		lastSequenceSaved.map((doc) => ctx.db.delete("files_pending_updates_last_sequence_saved", doc._id)),
	);
	await Promise.all(pendingUpdates.map((doc) => ctx.db.delete("files_pending_updates", doc._id)));
	await Promise.all(membershipsAll.map((doc) => ctx.db.delete("workspaces_projects_users", doc._id)));
	await Promise.all(accessRoleAssignments.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)));
	await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_user_workspace_project_resource_permission", (q) => q.eq("userId", user._id))
		.collect()
		.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id))));
	// Keep auth identifiers for auth-preserving deletion finalization; auth purges
	// remove both the external Clerk pointer and the anonymous token that can mint sessions.
	if (args.deleteUserAuth) {
		await Promise.all(anonymousAuthTokens.map((doc) => ctx.db.delete("users_anon_tokens", doc._id)));
	}
	await ctx.db
		.query("quotas")
		.withIndex("by_user_quotaName", (q) => q.eq("userId", user._id))
		.collect()
		.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("quotas", doc._id))));
	if (args.deleteBillingState) {
		// Keep Polar usage snapshots whenever the user row remains. Active and
		// canceling subscription mirrors depend on this row during account recovery
		// and root billing bootstrap.
		await Promise.all(billingUsageSnapshots.map((doc) => ctx.db.delete("billing_usage_snapshots", doc._id)));
	}

	await ctx.db.patch("users", user._id, {
		...(args.deleteUserAuth ? { clerkUserId: null, anonymousAuthToken: undefined } : {}),
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

async function db_delete_project_shell(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
	},
) {
	await db_purge_workspace_project_content(ctx, args);

	await Promise.all([
		ctx.db
			.query("notifications")
			.withIndex("by_workspace_project_user", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId),
			)
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("notifications", doc._id)))),
		ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_project_user_active", (q) => q.eq("projectId", args.projectId))
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("workspaces_projects_users", doc._id)))),
		ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_workspace_project_user_role", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId),
			)
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)))),
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_workspace_project_resource_user_permission", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId),
			)
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)))),
	]);

	await Promise.all([
		ctx.db.delete("workspaces_projects", args.projectId),
		db_delete_data_deletion_requests(ctx, {
			scope: "project",
			workspaceId: args.workspaceId,
			projectId: args.projectId,
		}),
	]);
}

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
		// Ensure the user's workspace quota row exists before reusing or recreating
		// the personal default tenant.
		await quotas_db_ensure(ctx, {
			quotaName: "extra_workspaces",
			userId: user._id,
			now,
		});

		// Prefer the existing personal/home shell when it is still a valid default
		// tenant; creating a replacement is only for tombstoned or broken shells.
		const [workspace, project] =
			user.defaultWorkspaceId && user.defaultProjectId
				? await Promise.all([
						ctx.db.get("workspaces", user.defaultWorkspaceId),
						ctx.db.get("workspaces_projects", user.defaultProjectId),
					])
				: [null, null];
		const membership =
			workspace && project
				? await ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_user_workspace_project_active", (q) =>
							q.eq("userId", user._id).eq("workspaceId", workspace._id).eq("projectId", project._id),
						)
						.first()
				: null;
		let defaultTenant: { workspaceId: Id<"workspaces">; defaultProjectId: Id<"workspaces_projects"> };

		if (workspace?.default && project && project.workspaceId === workspace._id && membership) {
			// Restore the access shell that account-deletion finalization removes.
			// Data reset keeps the account live, so reuse the old default tenant but
			// make its quota, membership, owner role, and seeded grants usable again
			// before purging only the tenant content below.
			await quotas_db_ensure(ctx, {
				quotaName: "extra_projects",
				workspaceId: workspace._id,
				now,
			});
			const memberships = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_user_workspace_project_active", (q) =>
					q.eq("userId", user._id).eq("workspaceId", workspace._id).eq("projectId", project._id),
				)
				.collect();
			const activeMembership = memberships.find((membership) => membership.active !== false);
			if (!activeMembership) {
				const inactiveMembership = memberships[0];
				if (inactiveMembership) {
					await ctx.db.patch("workspaces_projects_users", inactiveMembership._id, {
						active: true,
						updatedAt: now,
					});
				} else {
					await ctx.db.insert("workspaces_projects_users", {
						workspaceId: workspace._id,
						projectId: project._id,
						userId: user._id,
						active: true,
						updatedAt: now,
					});
				}
			} else if (activeMembership.active !== true) {
				await ctx.db.patch("workspaces_projects_users", activeMembership._id, {
					active: true,
					updatedAt: now,
				});
			}

			await access_control_db_ensure_role_assignment(ctx, {
				workspaceId: workspace._id,
				projectId: project._id,
				userId: user._id,
				role: "owner",
				now,
			});

			for (const grant of access_control_workspace_role_permission_grants) {
				await access_control_db_ensure_role_permission_grant(ctx, {
					workspaceId: workspace._id,
					projectId: project._id,
					resourceKind: "workspace",
					resourceId: String(workspace._id),
					role: grant.role,
					permission: grant.permission,
					now,
				});
			}

			for (const grant of access_control_project_role_permission_grants) {
				await access_control_db_ensure_role_permission_grant(ctx, {
					workspaceId: workspace._id,
					projectId: project._id,
					resourceKind: "project",
					resourceId: String(project._id),
					role: grant.role,
					permission: grant.permission,
					now,
				});
			}
			defaultTenant = {
				workspaceId: workspace._id,
				defaultProjectId: project._id,
			};
		} else {
			// If the old default tenant shell is gone or no longer valid, create a
			// fresh personal home tenant before deleting reset-owned data.
			const created = await workspaces_db_create(ctx, {
				userId: user._id,
				name: workspaces_DEFAULT_WORKSPACE_NAME,
				description: "",
				now,
				default: true,
			});
			if (created._nay) {
				throw convex_error({
					message: "Failed to create default workspace for user reset",
					cause: created._nay,
				});
			}
			defaultTenant = {
				workspaceId: created._yay.workspaceId,
				defaultProjectId: created._yay.defaultProjectId,
			};
		}

		// Data hard-delete is an explicit admin reset path for auth-preserved
		// user shells. Keep auth/profile/billing state and restore the default tenant.
		await Promise.all([
			ctx.db.patch("users", user._id, {
				defaultWorkspaceId: defaultTenant.workspaceId,
				defaultProjectId: defaultTenant.defaultProjectId,
				deletedAt: undefined,
			}),
			// Cancel every queued deletion owned by this user. A data hard-delete restores
			// the live account, so stale workspace/project requests from an earlier
			// tombstone must not later purge the rebuilt tenant shell.
			ctx.db
				.query("data_deletion_requests")
				.withIndex("by_user", (q) => q.eq("userId", user._id))
				.collect()
				.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("data_deletion_requests", doc._id)))),
		]);

		// Keep the default home project shell live, but remove every content row
		// inside it so the reset account opens into a clean, usable workspace.
		await db_purge_workspace_project_content(ctx, {
			workspaceId: defaultTenant.workspaceId,
			projectId: defaultTenant.defaultProjectId,
		});
		await Promise.all([
			db_delete_data_deletion_requests(ctx, {
				scope: "workspace",
				workspaceId: defaultTenant.workspaceId,
			}),
			db_delete_data_deletion_requests(ctx, {
				scope: "project",
				workspaceId: defaultTenant.workspaceId,
				projectId: defaultTenant.defaultProjectId,
			}),
		]);

		const defaultWorkspaceProjects = await ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspace_default", (q) => q.eq("workspaceId", defaultTenant.workspaceId))
			.collect();
		let deletedPersonalExtraProjectsCount = 0;
		// Extra projects under the personal workspace are user-owned data for this
		// reset flow. Leave only the primary home project behind.
		for (const project of defaultWorkspaceProjects) {
			if (project._id === defaultTenant.defaultProjectId || project.default) {
				continue;
			}

			await db_delete_project_shell(ctx, {
				workspaceId: defaultTenant.workspaceId,
				projectId: project._id,
			});
			deletedPersonalExtraProjectsCount += 1;
		}
		if (deletedPersonalExtraProjectsCount > 0) {
			// Direct shell deletion bypasses the queued project-deletion mutation,
			// so mirror the quota release here.
			await quotas_db_ensure(ctx, {
				quotaName: "extra_projects",
				workspaceId: defaultTenant.workspaceId,
				now,
			});
			const quota = await quotas_db_get(ctx, {
				quotaName: "extra_projects",
				workspaceId: defaultTenant.workspaceId,
			});
			await ctx.db.patch("quotas", quota._id, {
				usedCount: Math.max(0, quota.usedCount - deletedPersonalExtraProjectsCount),
				updatedAt: now,
			});
		}

		const memberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", user._id))
			.collect();
		const workspaceIdsToReview = new Set<Id<"workspaces">>();
		// Review non-default tenants from both directions: memberships catch shared
		// workspaces, while ownership catches rows left after prior deletion attempts.
		for (const membership of memberships) {
			if (membership.active !== false && membership.workspaceId !== defaultTenant.workspaceId) {
				workspaceIdsToReview.add(membership.workspaceId);
			}
		}

		const ownedWorkspaces = await ctx.db
			.query("workspaces")
			.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", user._id))
			.collect();
		for (const workspace of ownedWorkspaces) {
			if (!workspace.default && workspace._id !== defaultTenant.workspaceId) {
				workspaceIdsToReview.add(workspace._id);
			}
		}

		let deletedOwnedWorkspacesCount = 0;
		for (const workspaceId of workspaceIdsToReview) {
			const workspace = await ctx.db.get("workspaces", workspaceId);
			if (!workspace || workspace.default) {
				continue;
			}

			const projects = await ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspace_default", (q) => q.eq("workspaceId", workspace._id))
				.collect();
			let hasOtherActiveUser = false;
			// Check each project for an active member other than the reset user.
			for (const project of projects) {
				const [activeUserBefore, activeUserAfter] = await Promise.all([
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_active_workspace_project_user", (q) =>
							q.eq("active", true).eq("workspaceId", workspace._id).eq("projectId", project._id).lt("userId", user._id),
						)
						.first(),
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_active_workspace_project_user", (q) =>
							q.eq("active", true).eq("workspaceId", workspace._id).eq("projectId", project._id).gt("userId", user._id),
						)
						.first(),
				]);
				if (activeUserBefore || activeUserAfter) {
					hasOtherActiveUser = true;
					break;
				}
			}

			if (workspace.ownerUserId === user._id && !hasOtherActiveUser) {
				// An owned workspace with no other active users is effectively private
				// data for this account, so delete the whole tenant shell immediately.
				const { projectRequestsToDelete } = await db_delete_workspace(ctx, {
					workspaceId: workspace._id,
				});

				await Promise.all([
					db_delete_data_deletion_requests(ctx, {
						scope: "workspace",
						workspaceId: workspace._id,
					}),
					...projectRequestsToDelete.map((projectRequest) =>
						db_delete_data_deletion_requests(ctx, {
							scope: "project",
							workspaceId: projectRequest.workspaceId,
							projectId: projectRequest.projectId,
						}),
					),
				]);
				deletedOwnedWorkspacesCount += 1;
				continue;
			}

			let deletedSharedExtraProjectsCount = 0;
			// In shared workspaces, preserve the workspace/home roster and only delete
			// extra projects that have no active member other than the reset user.
			for (const project of projects) {
				if (project.default || project._id === workspace.defaultProjectId) {
					continue;
				}

				const [resetUserMembership, activeUserBefore, activeUserAfter] = await Promise.all([
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_active_user_workspace_project", (q) =>
							q.eq("active", true).eq("userId", user._id).eq("workspaceId", workspace._id).eq("projectId", project._id),
						)
						.first(),
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_active_workspace_project_user", (q) =>
							q.eq("active", true).eq("workspaceId", workspace._id).eq("projectId", project._id).lt("userId", user._id),
						)
						.first(),
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_active_workspace_project_user", (q) =>
							q.eq("active", true).eq("workspaceId", workspace._id).eq("projectId", project._id).gt("userId", user._id),
						)
						.first(),
				]);
				if (!resetUserMembership || activeUserBefore || activeUserAfter) {
					continue;
				}

				await db_delete_project_shell(ctx, {
					workspaceId: workspace._id,
					projectId: project._id,
				});
				deletedSharedExtraProjectsCount += 1;
			}
			if (deletedSharedExtraProjectsCount > 0) {
				// Match the shared workspace quota to the project shells removed
				// above; the normal queued worker is not involved in this reset path.
				await quotas_db_ensure(ctx, {
					quotaName: "extra_projects",
					workspaceId: workspace._id,
					now,
				});
				const quota = await quotas_db_get(ctx, {
					quotaName: "extra_projects",
					workspaceId: workspace._id,
				});
				await ctx.db.patch("quotas", quota._id, {
					usedCount: Math.max(0, quota.usedCount - deletedSharedExtraProjectsCount),
					updatedAt: now,
				});
			}
		}

		if (deletedOwnedWorkspacesCount > 0) {
			// Owned workspaces deleted inline must release the user's extra-workspace
			// quota immediately because no workspace deletion request will run later.
			await quotas_db_ensure(ctx, {
				quotaName: "extra_workspaces",
				userId: user._id,
				now,
			});
			const quota = await quotas_db_get(ctx, {
				quotaName: "extra_workspaces",
				userId: user._id,
			});
			await ctx.db.patch("quotas", quota._id, {
				usedCount: Math.max(0, quota.usedCount - deletedOwnedWorkspacesCount),
				updatedAt: now,
			});
		}

		return null;
	},
});

export const finalize_user_deletion_data = internalMutation({
	args: {
		userId: v.id("users"),
		deleteUserAuth: v.optional(v.boolean()),
		deleteBillingState: v.optional(v.boolean()),
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
			deleteUserAuth: args.deleteUserAuth,
			deleteBillingState: args.deleteBillingState,
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
