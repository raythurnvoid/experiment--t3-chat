import { v } from "convex/values";
import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import type { RegisteredMutation } from "convex/server";
import { components, internal } from "./_generated/api.js";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import app_convex_schema from "./schema.ts";
import { presence } from "./presence.ts";
import { quotas_db_ensure, quotas_db_get } from "./quotas.ts";
import { workspaces_DEFAULT_PROJECT_NAME, workspaces_DEFAULT_WORKSPACE_NAME } from "../shared/workspaces.ts";
import {
	access_control_project_role_permission_grants,
	access_control_db_ensure_role_assignment,
	access_control_db_ensure_role_permission_grant,
	access_control_workspace_role_permission_grants,
} from "./access_control.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PROJECT_CONTENT_PURGE_BATCH_SIZE = 100;

const R2_BUCKET_FILES = process.env.R2_BUCKET_FILES;
if (!R2_BUCKET_FILES) {
	throw new Error("R2_BUCKET_FILES is not set in Convex env");
}

const R2_ENDPOINT = process.env.R2_ENDPOINT;
if (!R2_ENDPOINT) {
	throw new Error("R2_ENDPOINT is not set in Convex env");
}

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
if (!R2_ACCESS_KEY_ID) {
	throw new Error("R2_ACCESS_KEY_ID is not set in Convex env");
}

const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
if (!R2_SECRET_ACCESS_KEY) {
	throw new Error("R2_SECRET_ACCESS_KEY is not set in Convex env");
}

const r2 = new R2(components.r2, {
	bucket: R2_BUCKET_FILES,
	endpoint: R2_ENDPOINT,
	accessKeyId: R2_ACCESS_KEY_ID,
	secretAccessKey: R2_SECRET_ACCESS_KEY,
});

/**
 * Workpool handle for file content-materialization jobs.
 *
 * Project purges use it to cancel outstanding jobs before deleting their
 * tracking docs.
 */
const files_content_materialization_workpool = new Workpool(components.files_content_materialization_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

/**
 * Workpool handle for upload-conversion jobs attached to R2 asset docs.
 *
 * Project purges cancel those jobs before deleting the asset docs and R2
 * objects.
 */
const files_upload_conversion_workpool = new Workpool(components.files_upload_conversion_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

/**
 * Workpool that runs the deletion request processor.
 *
 * It serializes user, workspace, and project queue processing so large purges
 * advance through bounded retryable worker passes.
 */
const data_deletion_workpool = new Workpool(components.data_deletion_workpool, {
	maxParallelism: 1,
});

function batch_size(args: { _test_batchSize?: number }) {
	return Math.max(
		1,
		Math.min(args._test_batchSize ?? PROJECT_CONTENT_PURGE_BATCH_SIZE, PROJECT_CONTENT_PURGE_BATCH_SIZE),
	);
}

/**
 * Creates a deletion request, or updates the existing request for the same target.
 *
 * The same user, workspace, or project should only have one queued request.
 * If the request already exists, keep the earlier processing time.
 */
export async function data_deletion_db_request(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		workspaceId?: Id<"workspaces">;
		projectId?: Id<"workspaces_projects">;
		scope: Doc<"data_deletion_requests">["scope"];
		eligibleAt?: number;
	},
) {
	// Without an explicit time, wait for the normal retention period.
	// Admin and cleanup paths can pass `eligibleAt` when work should run sooner.
	const eligibleAt = args.eligibleAt ?? Date.now() + RETENTION_MS;

	// User deletion has one queue doc per user.
	if (args.scope === "user") {
		const existing = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_user_scope", (q) => q.eq("userId", args.userId).eq("scope", "user"))
			.first();

		if (existing) {
			// Do not move an existing user deletion later.
			// Keep whichever request becomes eligible first.
			await ctx.db.patch("data_deletion_requests", existing._id, {
				eligibleAt: Math.min(existing.eligibleAt, eligibleAt),
			});
			return existing._id;
		}

		return await ctx.db.insert("data_deletion_requests", {
			userId: args.userId,
			scope: "user",
			eligibleAt,
		});
	}

	// Workspace and project deletion requests must name the workspace they belong to.
	if (!args.workspaceId) {
		throw new Error("Workspace id is required for workspace/project deletion requests");
	}

	// Project deletion has one queue doc per workspace/project pair.
	if (args.scope === "project") {
		if (!args.projectId) {
			throw new Error("Project id is required for project deletion requests");
		}

		const existingProjectRequests = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_workspace_project_scope", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("scope", "project"),
			)
			.first();

		if (existingProjectRequests) {
			// Do not move an existing project deletion later.
			// Keep whichever request becomes eligible first.
			await ctx.db.patch("data_deletion_requests", existingProjectRequests._id, {
				eligibleAt: Math.min(existingProjectRequests.eligibleAt, eligibleAt),
			});
			return existingProjectRequests._id;
		}

		return await ctx.db.insert("data_deletion_requests", {
			userId: args.userId,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			scope: "project",
			eligibleAt,
		});
	}

	// Workspace deletion has one queue doc per workspace. It is separate from
	// project requests in the same workspace.
	const existingWorkspaceRequest = await ctx.db
		.query("data_deletion_requests")
		.withIndex("by_workspace_scope", (q) => q.eq("workspaceId", args.workspaceId).eq("scope", "workspace"))
		.first();

	if (existingWorkspaceRequest) {
		// Do not move an existing workspace deletion later.
		// Keep whichever request becomes eligible first.
		await ctx.db.patch("data_deletion_requests", existingWorkspaceRequest._id, {
			eligibleAt: Math.min(existingWorkspaceRequest.eligibleAt, eligibleAt),
		});
		return existingWorkspaceRequest._id;
	}

	return await ctx.db.insert("data_deletion_requests", {
		userId: args.userId,
		scope: "workspace",
		workspaceId: args.workspaceId,
		eligibleAt,
	});
}

/**
 * Creates a new personal/default workspace and home project for a user.
 *
 * This is used after membership cleanup leaves an existing user without their
 * default workspace. Data reset paths do not silently repair a broken preserved
 * default tenant.
 */
async function db_create_default_workspace_and_project_for_user(
	ctx: MutationCtx,
	args: { userId: Id<"users">; now: number },
) {
	// Create the parent workspace before the default project so all child docs
	// can reference stable ids.
	const workspaceId = await ctx.db.insert("workspaces", {
		name: workspaces_DEFAULT_WORKSPACE_NAME,
		description: "",
		default: true,
		billingMode: "user",
		ownerUserId: args.userId,
		updatedAt: args.now,
	});

	const defaultProjectId = await ctx.db.insert("workspaces_projects", {
		workspaceId,
		name: workspaces_DEFAULT_PROJECT_NAME,
		description: "",
		default: true,
		updatedAt: args.now,
	});

	// Wire the new tenant together: default-project pointer, project quota,
	// active membership, owner role, and user default pointers.
	await Promise.all([
		ctx.db.patch("workspaces", workspaceId, {
			defaultProjectId,
		}),
		quotas_db_ensure(ctx, {
			quotaName: "extra_projects",
			workspaceId,
			now: args.now,
		}),
		ctx.db.insert("workspaces_projects_users", {
			workspaceId,
			projectId: defaultProjectId,
			userId: args.userId,
			active: true,
			updatedAt: args.now,
		}),
		access_control_db_ensure_role_assignment(ctx, {
			workspaceId,
			projectId: defaultProjectId,
			userId: args.userId,
			role: "owner",
			now: args.now,
		}),
		ctx.db.patch("users", args.userId, {
			defaultWorkspaceId: workspaceId,
			defaultProjectId,
		}),
	]);

	// Seed workspace-level grants from the canonical role permission list.
	for (const grant of access_control_workspace_role_permission_grants) {
		await access_control_db_ensure_role_permission_grant(ctx, {
			workspaceId,
			projectId: defaultProjectId,
			resourceKind: "workspace",
			resourceId: String(workspaceId),
			role: grant.role,
			permission: grant.permission,
			now: args.now,
		});
	}

	// Seed project-level grants for the default home project.
	for (const grant of access_control_project_role_permission_grants) {
		await access_control_db_ensure_role_permission_grant(ctx, {
			workspaceId,
			projectId: defaultProjectId,
			resourceKind: "project",
			resourceId: String(defaultProjectId),
			role: grant.role,
			permission: grant.permission,
			now: args.now,
		});
	}

	return { workspaceId, defaultProjectId };
}

/**
 * Ensures membership cleanup does not leave an existing user without a default workspace.
 */
async function db_ensure_default_workspace_and_project_for_user(
	ctx: MutationCtx,
	args: { userId: Id<"users">; now: number },
) {
	const user = await ctx.db.get("users", args.userId);
	// Missing user docs are already-deleted accounts.
	if (!user) {
		return;
	}

	// Existing users with a missing default workspace get a fresh
	// personal/default tenant.
	const defaultWorkspace = user.defaultWorkspaceId ? await ctx.db.get("workspaces", user.defaultWorkspaceId) : null;
	if (!defaultWorkspace) {
		await db_create_default_workspace_and_project_for_user(ctx, args);
	}
}

/**
 * Deletes one bounded batch of project-owned content docs.
 *
 * Queue processors call this repeatedly. Each branch deletes one class of docs
 * and returns immediately so large projects stay within mutation limits.
 */
async function db_purge_workspace_project_content_batch(
	ctx: MutationCtx,
	args: { workspaceId: Id<"workspaces">; projectId: Id<"workspaces_projects">; batchSize: number },
) {
	const { workspaceId, projectId, batchSize } = args;

	// Pending-update parent docs own cleanup-task and chunk docs. Delete those
	// children first, then delete the parent pending-update doc.
	const pendingUpdate = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_workspace_project_user_fileNode", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.first();
	if (pendingUpdate) {
		const cleanupTasks = await ctx.db
			.query("files_pending_updates_cleanup_tasks")
			.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", pendingUpdate._id))
			.take(batchSize);
		if (cleanupTasks.length > 0) {
			await Promise.all(cleanupTasks.map((doc) => ctx.db.delete("files_pending_updates_cleanup_tasks", doc._id)));
			return { done: false, deletedCount: cleanupTasks.length };
		}

		const chunks = await ctx.db
			.query("files_pending_updates_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", pendingUpdate._id))
			.take(batchSize);
		if (chunks.length > 0) {
			await Promise.all(chunks.map((doc) => ctx.db.delete("files_pending_updates_chunks", doc._id)));
			return { done: false, deletedCount: chunks.length };
		}

		await ctx.db.delete("files_pending_updates", pendingUpdate._id);
		return { done: false, deletedCount: 1 };
	}

	// Last-sequence docs are independent of pending-update parents but still
	// scoped to the project being purged.
	const lastSequenceSaved = await ctx.db
		.query("files_pending_updates_last_sequence_saved")
		.withIndex("by_workspace_project_fileNode_user", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.take(batchSize);
	if (lastSequenceSaved.length > 0) {
		await Promise.all(
			lastSequenceSaved.map((doc) => ctx.db.delete("files_pending_updates_last_sequence_saved", doc._id)),
		);
		return { done: false, deletedCount: lastSequenceSaved.length };
	}

	// AI file content docs are deleted before the AI file metadata docs.
	const aiFileContents = await ctx.db
		.query("ai_chat_files_content")
		.withIndex("by_workspace_project_fileNode", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.take(batchSize);
	if (aiFileContents.length > 0) {
		await Promise.all(aiFileContents.map((doc) => ctx.db.delete("ai_chat_files_content", doc._id)));
		return { done: false, deletedCount: aiFileContents.length };
	}

	const aiFiles = await ctx.db
		.query("ai_chat_files")
		.withIndex("by_workspace_project_thread_path", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.take(batchSize);
	if (aiFiles.length > 0) {
		await Promise.all(aiFiles.map((doc) => ctx.db.delete("ai_chat_files", doc._id)));
		return { done: false, deletedCount: aiFiles.length };
	}

	// AI thread messages and state are children of the thread docs, so they are
	// removed before deleting the thread docs themselves.
	const aiChatMessages = await ctx.db
		.query("ai_chat_threads_messages_aisdk_5")
		.withIndex("by_workspace_project_thread", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.take(batchSize);
	if (aiChatMessages.length > 0) {
		await Promise.all(aiChatMessages.map((doc) => ctx.db.delete("ai_chat_threads_messages_aisdk_5", doc._id)));
		return { done: false, deletedCount: aiChatMessages.length };
	}

	const aiChatThreadStates = await ctx.db
		.query("ai_chat_threads_state")
		.withIndex("by_workspace_project_thread", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.take(batchSize);
	if (aiChatThreadStates.length > 0) {
		await Promise.all(aiChatThreadStates.map((doc) => ctx.db.delete("ai_chat_threads_state", doc._id)));
		return { done: false, deletedCount: aiChatThreadStates.length };
	}

	const aiChatThreads = await ctx.db
		.query("ai_chat_threads")
		.withIndex("by_workspace_project_archived_lastMessageAt", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)
		.take(batchSize);
	if (aiChatThreads.length > 0) {
		await Promise.all(aiChatThreads.map((doc) => ctx.db.delete("ai_chat_threads", doc._id)));
		return { done: false, deletedCount: aiChatThreads.length };
	}

	// Legacy chat messages are still project-scoped content and are purged with
	// the same bounded batch discipline.
	const chatMessages = await ctx.db
		.query("chat_messages")
		.withIndex("by_workspace_project_thread", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.take(batchSize);
	if (chatMessages.length > 0) {
		await Promise.all(chatMessages.map((doc) => ctx.db.delete("chat_messages", doc._id)));
		return { done: false, deletedCount: chatMessages.length };
	}

	// File-derived content and snapshot docs are removed before jobs, assets,
	// and file nodes, which are cleaned up at the end of this helper.
	const plainTextChunks = await ctx.db
		.query("files_plain_text_chunks")
		.withIndex("by_workspace_project_fileNode_yjsSequence_chunkIndex", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)
		.take(batchSize);
	if (plainTextChunks.length > 0) {
		await Promise.all(plainTextChunks.map((doc) => ctx.db.delete("files_plain_text_chunks", doc._id)));
		return { done: false, deletedCount: plainTextChunks.length };
	}

	const markdownChunks = await ctx.db
		.query("files_markdown_chunks")
		.withIndex("by_workspace_project_fileNode_yjsSequence_chunkIndex", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)
		.take(batchSize);
	if (markdownChunks.length > 0) {
		await Promise.all(markdownChunks.map((doc) => ctx.db.delete("files_markdown_chunks", doc._id)));
		return { done: false, deletedCount: markdownChunks.length };
	}

	const yjsSnapshots = await ctx.db
		.query("files_yjs_snapshots")
		.withIndex("by_workspace_project_fileNode_sequence", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)
		.take(batchSize);
	if (yjsSnapshots.length > 0) {
		await Promise.all(yjsSnapshots.map((doc) => ctx.db.delete("files_yjs_snapshots", doc._id)));
		return { done: false, deletedCount: yjsSnapshots.length };
	}

	const yjsUpdates = await ctx.db
		.query("files_yjs_updates")
		.withIndex("by_workspace_project_fileNode_sequence", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)
		.take(batchSize);
	if (yjsUpdates.length > 0) {
		await Promise.all(yjsUpdates.map((doc) => ctx.db.delete("files_yjs_updates", doc._id)));
		return { done: false, deletedCount: yjsUpdates.length };
	}

	const yjsLastSequences = await ctx.db
		.query("files_yjs_docs_last_sequences")
		.withIndex("by_workspace_project_fileNode", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.take(batchSize);
	if (yjsLastSequences.length > 0) {
		await Promise.all(yjsLastSequences.map((doc) => ctx.db.delete("files_yjs_docs_last_sequences", doc._id)));
		return { done: false, deletedCount: yjsLastSequences.length };
	}

	const fileSnapshots = await ctx.db
		.query("files_snapshots")
		.withIndex("by_workspace_project_fileNode_archivedAt", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)
		.take(batchSize);
	if (fileSnapshots.length > 0) {
		await Promise.all(fileSnapshots.map((doc) => ctx.db.delete("files_snapshots", doc._id)));
		return { done: false, deletedCount: fileSnapshots.length };
	}

	const fileStats = await ctx.db
		.query("file_stats")
		.withIndex("by_workspace_project_fileNode", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.take(batchSize);
	if (fileStats.length > 0) {
		await Promise.all(fileStats.map((doc) => ctx.db.delete("file_stats", doc._id)));
		return { done: false, deletedCount: fileStats.length };
	}

	// Cancel materialization jobs before deleting their tracking docs.
	const materializationJobs = await ctx.db
		.query("files_content_materialization_jobs")
		.withIndex("by_workspace_project_fileNode", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.take(batchSize);
	if (materializationJobs.length > 0) {
		await Promise.all(materializationJobs.map((job) => files_content_materialization_workpool.cancel(ctx, job.jobId)));
		await Promise.all(materializationJobs.map((doc) => ctx.db.delete("files_content_materialization_jobs", doc._id)));
		return { done: false, deletedCount: materializationJobs.length };
	}

	// Delete external R2 objects and cancel upload-conversion jobs before
	// removing the asset docs that track them.
	const assets = await ctx.db
		.query("files_r2_assets")
		.withIndex("by_workspace_project", (q) => q.eq("workspaceId", workspaceId).eq("projectId", projectId))
		.take(batchSize);
	if (assets.length > 0) {
		await Promise.all(
			assets.flatMap((asset) =>
				asset.conversionWorkId ? [files_upload_conversion_workpool.cancel(ctx, asset.conversionWorkId)] : [],
			),
		);
		await Promise.all(assets.flatMap((asset) => (asset.r2Key ? [r2.deleteObject(ctx, asset.r2Key)] : [])));
		await Promise.all(assets.map((doc) => ctx.db.delete("files_r2_assets", doc._id)));
		return { done: false, deletedCount: assets.length };
	}

	// File nodes are deleted last because the content, job, and asset docs above
	// can reference them.
	const fileNodes = await ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_parent_name_archiveOperation", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId),
		)
		.take(batchSize);
	if (fileNodes.length > 0) {
		await Promise.all(fileNodes.map((doc) => ctx.db.delete("files_nodes", doc._id)));
		return { done: false, deletedCount: fileNodes.length };
	}

	return { done: true, deletedCount: 0 };
}

/**
 * Clears completed queue docs for exactly one deletion scope.
 *
 * Workspace and project deletion requests share resource indexes, so the final
 * filter below keeps one scope from consuming another scope's queue doc.
 */
async function db_delete_data_deletion_requests(
	ctx: MutationCtx,
	args:
		| { scope: "user"; userId: Id<"users"> }
		| { scope: "workspace"; workspaceId: Id<"workspaces"> }
		| { scope: "project"; workspaceId: Id<"workspaces">; projectId: Id<"workspaces_projects"> },
) {
	// User deletion finalization only clears the user-scope queue doc.
	// Workspace/project queue docs may still own tenant purge work.
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

	// Resource deletion cleanup is scoped by workspace/project ids and then
	// filtered by explicit request scope so workspace cleanup does not delete a
	// queued project purge.
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

/**
 * Deletes project structure after project content is gone.
 *
 * Each call removes one bounded class of docs so large project deletion remains
 * retryable across scheduled deletion worker runs.
 */
async function db_delete_project_structure_batch(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		batchSize: number;
	},
) {
	// Remove user-facing project notifications before removing access docs and
	// the project doc itself.
	const notifications = await ctx.db
		.query("notifications")
		.withIndex("by_workspace_project_user", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId),
		)
		.take(args.batchSize);
	if (notifications.length > 0) {
		await Promise.all(notifications.map((doc) => ctx.db.delete("notifications", doc._id)));
		return { done: false, deletedCount: notifications.length };
	}

	// Project memberships and direct access-control docs are structural state.
	// Heavy project content has already been purged before this helper runs.
	const memberships = await ctx.db
		.query("workspaces_projects_users")
		.withIndex("by_project_user_active", (q) => q.eq("projectId", args.projectId))
		.take(args.batchSize);
	if (memberships.length > 0) {
		await Promise.all(memberships.map((doc) => ctx.db.delete("workspaces_projects_users", doc._id)));
		return { done: false, deletedCount: memberships.length };
	}

	const roleAssignments = await ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_workspace_project_user_role", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId),
		)
		.take(args.batchSize);
	if (roleAssignments.length > 0) {
		await Promise.all(roleAssignments.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)));
		return { done: false, deletedCount: roleAssignments.length };
	}

	const permissionGrants = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_workspace_project_resource_user_permission", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId),
		)
		.take(args.batchSize);
	if (permissionGrants.length > 0) {
		await Promise.all(permissionGrants.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)));
		return { done: false, deletedCount: permissionGrants.length };
	}

	// Delete the project doc last so retries can continue to target the same
	// project id until all child structure is gone.
	const project = await ctx.db.get("workspaces_projects", args.projectId);
	if (project) {
		await ctx.db.delete("workspaces_projects", project._id);
		return { done: true, deletedCount: 1 };
	}

	return { done: true, deletedCount: 0 };
}

/**
 * Runs project deletion in two phases: content first, then structure.
 */
async function db_delete_project_batch(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		batchSize: number;
	},
) {
	const content = await db_purge_workspace_project_content_batch(ctx, args);
	if (!content.done) {
		return content;
	}

	const structural = await db_delete_project_structure_batch(ctx, args);
	if (!structural.done) {
		return structural;
	}

	// The project queue doc is complete only after both content and structure
	// have been deleted.
	await db_delete_data_deletion_requests(ctx, {
		scope: "project",
		workspaceId: args.workspaceId,
		projectId: args.projectId,
	});

	return { done: true, deletedCount: content.deletedCount + structural.deletedCount };
}

/**
 * Deletes one bounded workspace batch.
 *
 * Workspace cleanup drains queued project-content purges first, then deletes
 * remaining project docs, workspace-level structure, and finally the workspace doc.
 */
async function db_delete_workspace_batch(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		batchSize: number;
	},
) {
	// A workspace request may include project purge docs that outlive their
	// project docs. Drain those queued content purges before scanning projects.
	const queuedProjectRequest = await ctx.db
		.query("data_deletion_requests")
		.withIndex("by_workspace_scope", (q) => q.eq("workspaceId", args.workspaceId).eq("scope", "project"))
		.first();
	if (queuedProjectRequest?.projectId) {
		const content = await db_purge_workspace_project_content_batch(ctx, {
			workspaceId: args.workspaceId,
			projectId: queuedProjectRequest.projectId,
			batchSize: args.batchSize,
		});
		if (!content.done) {
			return content;
		}

		await ctx.db.delete("data_deletion_requests", queuedProjectRequest._id);
		return { done: false, deletedCount: 1 };
	}

	// Existing project docs still need full project deletion before workspace
	// structure can be removed.
	const project = await ctx.db
		.query("workspaces_projects")
		.withIndex("by_workspace_default", (q) => q.eq("workspaceId", args.workspaceId))
		.first();
	if (project) {
		const result = await db_delete_project_batch(ctx, {
			workspaceId: args.workspaceId,
			projectId: project._id,
			batchSize: args.batchSize,
		});
		return result.done ? { done: false, deletedCount: result.deletedCount } : result;
	}

	// Once projects are gone, remove workspace-level structure in bounded
	// chunks before deleting the workspace doc.
	const notifications = await ctx.db
		.query("notifications")
		.withIndex("by_workspace_user_read", (q) => q.eq("workspaceId", args.workspaceId))
		.take(args.batchSize);
	if (notifications.length > 0) {
		await Promise.all(notifications.map((doc) => ctx.db.delete("notifications", doc._id)));
		return { done: false, deletedCount: notifications.length };
	}

	const roleAssignments = await ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_workspace_project_user_role", (q) => q.eq("workspaceId", args.workspaceId))
		.take(args.batchSize);
	if (roleAssignments.length > 0) {
		await Promise.all(roleAssignments.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)));
		return { done: false, deletedCount: roleAssignments.length };
	}

	const permissionGrants = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_workspace_project_resource_user_permission", (q) => q.eq("workspaceId", args.workspaceId))
		.take(args.batchSize);
	if (permissionGrants.length > 0) {
		await Promise.all(permissionGrants.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)));
		return { done: false, deletedCount: permissionGrants.length };
	}

	const quotaDocs = await ctx.db
		.query("quotas")
		.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", args.workspaceId))
		.take(args.batchSize);
	if (quotaDocs.length > 0) {
		await Promise.all(quotaDocs.map((doc) => ctx.db.delete("quotas", doc._id)));
		return { done: false, deletedCount: quotaDocs.length };
	}

	// Delete the workspace doc last so retries can continue to target the same
	// workspace id until all scoped docs are gone.
	const workspace = await ctx.db.get("workspaces", args.workspaceId);
	if (workspace) {
		await ctx.db.delete("workspaces", args.workspaceId);
		return { done: true, deletedCount: 1 };
	}

	return { done: true, deletedCount: 0 };
}

/**
 * Phase 1 for an owned non-default workspace during account deletion.
 *
 * The user-facing account deletion flow asks the owner to transfer or delete
 * owned workspaces first. Internal/admin deletion paths can still reach this
 * helper with an owned workspace. In that case, queue the workspace for the
 * phase-2 purge worker, remove access docs and memberships immediately, and
 * release the owner's workspace quota slot. The workspace/project docs and
 * heavy content are left for the queued workspace purge.
 */
async function db_queue_workspace_deletion_for_owner_account_deletion(
	ctx: MutationCtx,
	args: {
		workspaceOwnerUserId: Id<"users">;
		workspace: Doc<"workspaces">;
		now: number;
	},
) {
	// Do the immediate workspace cleanup in parallel:
	// - create or reuse the workspace-scope queue doc;
	// - remove role and permission docs so the workspace is no longer usable;
	// - remove project memberships and keep the affected user ids for default
	//   tenant checks below.
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

	// The owner consumed one `extra_workspaces` quota slot for this workspace.
	// Release it now because the workspace is already queued for deletion and no
	// longer usable by members.
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

	// Removing memberships can leave affected users without a usable default
	// tenant if this workspace was their only remaining workspace. Re-check each
	// affected user after membership removal.
	for (const userId of new Set<Id<"users">>(userIdsPerProject.flat())) {
		await db_ensure_default_workspace_and_project_for_user(ctx, {
			userId,
			now: args.now,
		});
	}
}

/**
 * Phase 1 for the user account itself.
 *
 * This marks the user as deleted and deactivates memberships, but keeps the
 * user doc and tenant docs in place during the retention window. That keeps the
 * deletion reversible while making the user's memberships non-effective.
 */
async function db_prepare_user_for_deletion(
	ctx: MutationCtx,
	args: {
		user: Doc<"users">;
		now: number;
	},
) {
	// Load memberships before tombstoning so the same set can be deactivated
	// together with the user doc.
	const memberships = await ctx.db
		.query("workspaces_projects_users")
		.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", args.user._id))
		.collect();

	// A repeated phase-1 call is idempotent. Once `deletedAt` is set, do not
	// rewrite memberships again.
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

		// This is the tombstone write: the user doc stays recoverable while `deletedAt` marks it deleted.
		await ctx.db.patch("users", args.user._id, {
			deletedAt: args.now,
		});
	}

	// Remove presence docs so the tombstoned user no longer appears in rooms.
	// The presence component tolerates missing docs if another cleanup already
	// removed some of them.
	const presenceRooms = await presence.listUser(ctx, args.user._id, false, 10_000);
	await Promise.all(presenceRooms.map((room) => presence.removeRoomUser(ctx, room.roomId, args.user._id)));
}

/**
 * Phase 2 for a tombstoned user.
 *
 * This removes user-scoped docs that can be deleted after retention. It can also
 * remove auth docs and billing snapshots when the caller is doing a full purge.
 * Workspace/project content is not deleted here. Instead, this returns the
 * workspace ids that became empty so the caller can queue or run workspace purge
 * with its own request bookkeeping.
 */
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
	// Only tombstoned users can be finalized. Missing users or non-deleted users
	// are no-ops for this helper.
	if (!user || user.deletedAt == null) {
		return;
	}

	const userIdString = String(user._id);
	// Pending-update parent docs have child cleanup/chunk docs. Gather children
	// before deletion so they can be deleted before their parent docs.
	const pendingUpdatesPromise = ctx.db
		.query("files_pending_updates")
		.withIndex("by_user_fileNode", (q) => q.eq("userId", userIdString))
		.collect();
	// Load all user-scoped docs needed for finalization before deleting them.
	// Auth and billing docs are conditional because data-only and auth-preserving
	// deletion paths must keep those docs.
	const [
		membershipsAll,
		accessRoleAssignments,
		anonymousAuthTokens,
		pendingUpdates,
		pendingUpdateCleanupTasks,
		pendingUpdateChunks,
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
		pendingUpdatesPromise,
		// These child lookups depend on the parent docs, but each child table can
		// be collected independently once `pendingUpdatesPromise` resolves.
		pendingUpdatesPromise.then(async (docs) =>
			(
				await Promise.all(
					docs.map((doc) =>
						ctx.db
							.query("files_pending_updates_cleanup_tasks")
							.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", doc._id))
							.collect(),
					),
				)
			).flat(),
		),
		pendingUpdatesPromise.then(async (docs) =>
			(
				await Promise.all(
					docs.map((doc) =>
						ctx.db
							.query("files_pending_updates_chunks")
							.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", doc._id))
							.collect(),
					),
				)
			).flat(),
		),
		ctx.db
			.query("files_pending_updates_last_sequence_saved")
			.withIndex("by_user_fileNode", (q) => q.eq("userId", userIdString))
			.collect(),
		args.deleteBillingState
			? ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", user._id))
					.collect()
			: Promise.resolve([] as Array<Doc<"billing_usage_snapshots">>),
	]);

	/**
	 * Workspace ids captured before deleting memberships and roles, used after cleanup
	 * to detect workspaces that no longer have any active members.
	 */
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

	// Delete pending-update children before parent pending-update docs.
	const [directPermissionGrants, userQuotaDocs] = await Promise.all([
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_user_workspace_project_resource_permission", (q) => q.eq("userId", user._id))
			.collect(),
		ctx.db
			.query("quotas")
			.withIndex("by_user_quotaName", (q) => q.eq("userId", user._id))
			.collect(),
		Promise.all([
			...pendingUpdateCleanupTasks.map((doc) => ctx.db.delete("files_pending_updates_cleanup_tasks", doc._id)),
			...pendingUpdateChunks.map((doc) => ctx.db.delete("files_pending_updates_chunks", doc._id)),
		]),
	]);

	await Promise.all([
		...lastSequenceSaved.map((doc) => ctx.db.delete("files_pending_updates_last_sequence_saved", doc._id)),
		...pendingUpdates.map((doc) => ctx.db.delete("files_pending_updates", doc._id)),
		// Remove membership and role docs so the finalized user no longer has access
		// to any project or workspace.
		...membershipsAll.map((doc) => ctx.db.delete("workspaces_projects_users", doc._id)),
		...accessRoleAssignments.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)),
		// Remove direct permission grants for this user. Role grants are handled by
		// workspace/project cleanup; this query targets user-principal grants.
		...directPermissionGrants.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)),
		// Keep auth identifiers for auth-preserving deletion finalization; auth purges
		// remove both the external Clerk pointer and the anonymous token that can mint sessions.
		...(args.deleteUserAuth ? anonymousAuthTokens.map((doc) => ctx.db.delete("users_anon_tokens", doc._id)) : []),
		// User-level quotas belong to the deleted account, not to a tenant. Remove
		// them once the user is finalized.
		...userQuotaDocs.map((doc) => ctx.db.delete("quotas", doc._id)),
		// Only full user-record purge paths pass `deleteBillingState`. Account
		// reset and auth-preserving deletion keep snapshots because billing
		// recovery and root billing bootstrap still need them.
		...(args.deleteBillingState
			? billingUsageSnapshots.map((doc) => ctx.db.delete("billing_usage_snapshots", doc._id))
			: []),
		// Leave a tombstone doc behind unless the caller later deletes the user doc.
		// Clear default tenant pointers because those tenant docs may be purged after
		// finalization. Clear auth pointers only for auth-removing paths.
		ctx.db.patch("users", user._id, {
			...(args.deleteUserAuth ? { clerkUserId: null, anonymousAuthToken: undefined } : {}),
			defaultWorkspaceId: undefined,
			defaultProjectId: undefined,
			deletedAt: user.deletedAt ?? args.now,
		}),
	]);

	const workspacesToDelete = [];

	// Return only fully empty workspaces here. The caller owns the actual
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

/**
 * Starts account deletion phase 1 and creates the user-scope queue doc.
 *
 * Still-owned non-default workspaces are queued before the user tombstone, so
 * restoring the user during retention does not restore those workspace deletions.
 */
export const init_user_deletion = internalMutation({
	args: {
		userId: v.id("users"),
		nowTs: v.optional(v.number()),
	},
	returns: v.union(v.id("data_deletion_requests"), v.null()),
	handler: async (ctx, args) => {
		const user = await ctx.db.get("users", args.userId);
		// Idempotent no-op when an admin path already removed the user doc.
		if (!user) {
			return null;
		}

		const now = args.nowTs ?? Date.now();
		// Internal/admin callers can still start account deletion for a user who
		// owns non-default workspaces. Queue those workspaces for phase 2 first.
		const ownedWorkspaces = await ctx.db
			.query("workspaces")
			.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", args.userId))
			.collect();

		for (const workspace of ownedWorkspaces.filter((workspace) => !workspace.default)) {
			// This removes access immediately and leaves workspace content for the
			// workspace-scope purge worker.
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

		// The user-scope request controls delayed phase-2 user finalization.
		const requestId = await data_deletion_db_request(ctx, {
			userId: args.userId,
			scope: "user",
		});

		return requestId;
	},
});

/**
 * Lists eligible queue docs for one deletion scope.
 *
 * The worker calls this separately for users, workspaces, and projects so the
 * action can enforce its processing order. `eligibleAt` is the retention gate:
 * docs with a future value stay queued until a later run.
 */
export const list_deletion_request_ids_by_scope = internalQuery({
	args: {
		scope: app_convex_schema.tables.data_deletion_requests.validator.fields.scope,
		limit: v.number(),
		_test_now: v.optional(v.number()),
	},
	returns: v.array(v.id("data_deletion_requests")),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const ids: Array<Id<"data_deletion_requests">> = [];

		// Read only docs whose scope is due. Stop at the caller's limit so one
		// worker run cannot materialize the whole queue.
		for await (const doc of ctx.db
			.query("data_deletion_requests")
			.withIndex("by_scope_eligibleAt", (q) => q.eq("scope", args.scope).lte("eligibleAt", now))
			.order("asc")) {
			ids.push(doc._id);
			if (ids.length >= args.limit) {
				break;
			}
		}

		return ids;
	},
});

/**
 * Returns whether any queued deletion doc still references this user.
 */
export const has_deletion_requests_for_user = internalQuery({
	args: {
		userId: v.id("users"),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const request = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.first();

		return request !== null;
	},
});

/**
 * Process one queued user-scope deletion.
 *
 * The caller must only pass request docs whose `eligibleAt` has passed.
 */
export const process_user_deletion_request = internalMutation({
	args: {
		requestId: v.id("data_deletion_requests"),
		/**
		 * Internal simulated wall time (ms) used by tests for finalization timestamps
		 * and now-eligible workspace requests created while processing the user.
		 *
		 * Omit in normal production flows (`Date.now()` is used).
		 */
		_test_now: v.optional(v.number()),
	},
	returns: v.object({
		done: v.boolean(),
		deletedCount: v.number(),
	}),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const request = await ctx.db.get("data_deletion_requests", args.requestId);

		// A retry can reach here after an earlier run already removed the queue doc.
		if (!request) {
			return { done: true, deletedCount: 0 };
		}

		// This mutation only owns user-scope requests.
		if (request.scope !== "user") {
			return { done: true, deletedCount: 0 };
		}

		const user = await ctx.db.get("users", request.userId);

		// The user doc can be purged manually or by an admin path before the queued
		// request runs. Still clear quota docs from the request's user id.
		if (!user) {
			await Promise.all([
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) => q.eq("userId", request.userId))
					.collect()
					.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("quotas", doc._id)))),
				ctx.db.delete("data_deletion_requests", request._id),
			]);
			return { done: true, deletedCount: 1 };
		}

		// A user request is valid only for a tombstoned user. Keep the request doc
		// and log if a caller queued it before setting `deletedAt`.
		if (user.deletedAt == null) {
			console.error("Deletion request made no progress", {
				scope: "user",
				requestId: request._id,
			});
			return { done: false, deletedCount: 0 };
		}

		// Finalize the user first to delete the remaining user-owned docs and to
		// compute which workspaces became fully empty at the retention boundary.
		const deleteUserRes = await db_finalize_deleted_user(ctx, {
			userId: user._id,
			now: now,
		});

		// Queue immediate workspace deletions for workspaces that became empty while
		// finalizing this user.
		if (deleteUserRes?.workspacesToDelete) {
			for (const workspace of deleteUserRes.workspacesToDelete) {
				await data_deletion_db_request(ctx, {
					userId: request.userId,
					workspaceId: workspace.workspaceId,
					scope: "workspace",
					eligibleAt: now,
				});
			}
		}

		// User finalization and follow-up workspace queueing are complete.
		await ctx.db.delete("data_deletion_requests", request._id);

		return { done: true, deletedCount: 1 };
	},
});

type process_user_deletion_request_Result =
	typeof process_user_deletion_request extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Process one queued workspace-scope deletion.
 *
 * The caller must only pass request docs whose `eligibleAt` has passed.
 */
export const process_workspace_deletion_request = internalMutation({
	args: {
		requestId: v.id("data_deletion_requests"),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.object({
		done: v.boolean(),
		deletedCount: v.number(),
	}),
	handler: async (ctx, args) => {
		const request = await ctx.db.get("data_deletion_requests", args.requestId);

		// A retry can reach here after an earlier run already removed the queue doc.
		if (!request) {
			return { done: true, deletedCount: 0 };
		}

		// This mutation only owns workspace-scope requests.
		if (request.scope !== "workspace") {
			return { done: true, deletedCount: 0 };
		}

		const workspaceId = request.workspaceId;

		// A workspace request without a workspace id cannot target workspace docs.
		// Remove the invalid queue doc instead of retrying forever.
		if (!workspaceId) {
			await ctx.db.delete("data_deletion_requests", request._id);
			return { done: true, deletedCount: 1 };
		}

		// Delete only a limited number of docs for this workspace. If content or
		// structure remains, keep the request doc so the next worker run continues.
		const result = await db_delete_workspace_batch(ctx, {
			workspaceId,
			batchSize: batch_size(args),
		});

		// No-progress incomplete results should be rare. Log them so the queue does
		// not silently loop without deleting docs.
		if (!result.done) {
			if (result.deletedCount === 0) {
				console.error("Deletion request made no progress", {
					scope: "workspace",
					requestId: request._id,
				});
			}
			return result;
		}

		// All covered workspace content and structure is gone, so the queue doc is complete.
		await ctx.db.delete("data_deletion_requests", request._id);

		return { done: true, deletedCount: 1 };
	},
});

type process_workspace_deletion_request_Result =
	typeof process_workspace_deletion_request extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Process one queued project-scope deletion.
 *
 * The caller must only pass request docs whose `eligibleAt` has passed.
 */
export const process_project_deletion_request = internalMutation({
	args: {
		requestId: v.id("data_deletion_requests"),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.object({
		done: v.boolean(),
		deletedCount: v.number(),
	}),
	handler: async (ctx, args) => {
		const request = await ctx.db.get("data_deletion_requests", args.requestId);
		// A retry can reach here after an earlier run already removed the queue doc.
		if (!request) {
			return { done: true, deletedCount: 0 };
		}

		// This mutation only owns project-scope requests.
		if (request.scope !== "project") {
			return { done: true, deletedCount: 0 };
		}

		// A project request without both ids cannot target project content.
		// Remove the invalid queue doc instead of retrying forever.
		if (!request.workspaceId || !request.projectId) {
			await ctx.db.delete("data_deletion_requests", request._id);
			return { done: true, deletedCount: 1 };
		}

		// Delete only a limited number of docs for this project. If content remains,
		// keep the request doc so the next worker run continues from the same scope.
		const result = await db_purge_workspace_project_content_batch(ctx, {
			workspaceId: request.workspaceId,
			projectId: request.projectId,
			batchSize: batch_size(args),
		});
		if (!result.done) {
			if (result.deletedCount === 0) {
				console.error("Deletion request made no progress", {
					scope: "project",
					requestId: request._id,
				});
			}
			return result;
		}

		// All covered project content is gone, so this queue doc is complete.
		await ctx.db.delete("data_deletion_requests", request._id);

		return { done: true, deletedCount: 1 };
	},
});

type process_project_deletion_request_Result =
	typeof process_project_deletion_request extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Reset one user's data without deleting the account.
 *
 * This is the admin data-only reset path. It keeps the `users` doc, auth ids,
 * profile, billing state, and default tenant: the `personal` workspace plus
 * the `home` project. Each call deletes only a limited number of docs, so
 * callers should invoke it again when it returns `done: false`.
 */
export const hard_delete_user_data = internalMutation({
	args: {
		userId: v.id("users"),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.object({
		done: v.boolean(),
		deletedCount: v.number(),
	}),
	handler: async (ctx, args) => {
		const user = await ctx.db.get("users", args.userId);
		if (!user) {
			// The local user doc is already gone, so there is no account to reset.
			return { done: true, deletedCount: 0 };
		}

		const now = Date.now();

		// The app expects every usable account to have a workspace quota doc.
		// Ensure it before we reuse the user's default workspace.
		await quotas_db_ensure(ctx, {
			quotaName: "extra_workspaces",
			userId: user._id,
			now,
		});

		// Try to load the user's current default tenant from the pointers cached on
		// the user doc. This should normally be the personal workspace and home project.
		const [workspace, project] =
			user.defaultWorkspaceId && user.defaultProjectId
				? await Promise.all([
						ctx.db.get("workspaces", user.defaultWorkspaceId),
						ctx.db.get("workspaces_projects", user.defaultProjectId),
					])
				: [null, null];
		// We also need a membership doc for the default project. Without it, the UI
		// cannot resolve the user's personal/home route after the reset.
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

		// Reuse the existing default tenant. First ensure its project quota doc;
		// then below ensure the membership, owner role, and grant docs that make
		// the default workspace/project usable after reset.
		if (
			workspace?.default &&
			project &&
			project.workspaceId === workspace._id &&
			workspace.defaultProjectId === project._id &&
			project.default &&
			membership
		) {
			await quotas_db_ensure(ctx, {
				quotaName: "extra_projects",
				workspaceId: workspace._id,
				now,
			});

			// Check for an active default-project membership doc directly. A broad
			// `first()` could return an inactive doc even when an active one exists.
			const activeMembership = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q.eq("active", true).eq("userId", user._id).eq("workspaceId", workspace._id).eq("projectId", project._id),
				)
				.first();

			// If no active default-project membership exists, reactivate one
			// inactive doc for this same user/workspace/project instead of
			// creating a duplicate.
			if (!activeMembership) {
				const inactiveMembership = await ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_user_workspace_project_active", (q) =>
						q.eq("userId", user._id).eq("workspaceId", workspace._id).eq("projectId", project._id).eq("active", false),
					)
					.first();

				// The user had this default-project membership, but it was
				// deactivated during deletion setup. Mark it active again so the
				// user can open the personal/home project after the reset.
				if (inactiveMembership) {
					await ctx.db.patch("workspaces_projects_users", inactiveMembership._id, {
						active: true,
						updatedAt: now,
					});
				} else {
					const errorMessage = "Default tenant exists without a default-project membership doc during data reset";
					const errorData = {
						userId: user._id,
						workspaceId: workspace._id,
						projectId: project._id,
					};
					console.error(errorMessage, errorData);
					throw should_never_happen(errorMessage, errorData);
					// await ctx.db.insert("workspaces_projects_users", {
					// 	workspaceId: workspace._id,
					// 	projectId: project._id,
					// 	userId: user._id,
					// 	active: true,
					// 	updatedAt: now,
					// });
				}
			}

			// The user must remain owner of their personal/home project after reset.
			await access_control_db_ensure_role_assignment(ctx, {
				workspaceId: workspace._id,
				projectId: project._id,
				userId: user._id,
				role: "owner",
				now,
			});

			// Re-seed workspace-level grants. The helper is idempotent, so existing
			// grants are reused and missing grants are recreated.
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

			// Re-seed project-level grants for the home project.
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
			// Everything below must preserve these default workspace/project docs.
			defaultTenant = {
				workspaceId: workspace._id,
				defaultProjectId: project._id,
			};
		} else {
			const errorMessage = "Default tenant is missing or inconsistent during data reset";
			const errorData = {
				userId: user._id,
				defaultWorkspaceId: user.defaultWorkspaceId,
				defaultProjectId: user.defaultProjectId,
				workspaceFound: Boolean(workspace),
				workspaceDefault: workspace?.default,
				workspaceDefaultProjectId: workspace?.defaultProjectId,
				projectFound: Boolean(project),
				projectDefault: project?.default,
				projectWorkspaceId: project?.workspaceId,
				membershipFound: Boolean(membership),
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
			// Previous repair fallback, intentionally kept commented while we verify
			// this invariant in tests/logs. Do not re-enable without deciding that
			// missing default tenant docs should be repaired during data reset.
			// const created = await db_create_default_workspace_and_project_for_user(ctx, {
			// 	userId: user._id,
			// 	now,
			// });
			// defaultTenant = {
			// 	workspaceId: created.workspaceId,
			// 	defaultProjectId: created.defaultProjectId,
			// };
		}

		// Commit the usable account state before deleting data. This keeps auth,
		// profile, and billing state intact while making sure the user points to
		// the default workspace/project selected above.
		await Promise.all([
			// Clear `deletedAt` because a data reset should leave the account usable,
			// even if it started from a tombstoned state.
			ctx.db.patch("users", user._id, {
				defaultWorkspaceId: defaultTenant.workspaceId,
				defaultProjectId: defaultTenant.defaultProjectId,
				deletedAt: undefined,
			}),
			// Cancel the user-scope deletion request. Resource-scope requests must stay
			// queued until this reset either consumes them or proves they target the
			// preserved default workspace/project.
			db_delete_data_deletion_requests(ctx, {
				scope: "user",
				userId: user._id,
			}),
		]);

		// The personal/home project is the one project we keep. Purge only its
		// content docs so the user opens a clean home project after reset.
		const defaultProjectPurge = await db_purge_workspace_project_content_batch(ctx, {
			workspaceId: defaultTenant.workspaceId,
			projectId: defaultTenant.defaultProjectId,
			batchSize: batch_size(args),
		});
		if (!defaultProjectPurge.done) {
			// The home project still has more content than fits in this batch.
			return defaultProjectPurge;
		}
		await Promise.all([
			// The default tenant must not be deleted later by an old queued request.
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

		// Admin data reset can run after project deletion phase 1 but before the
		// queued background purge finishes phase 2:
		//
		// 1. `delete_project` has already queued a project-scope request.
		// 2. `delete_project` has already deleted the `workspaces_projects` doc,
		//    so scanning project docs below will not find this project anymore.
		// 3. The queued purge has not yet deleted that project's files, threads,
		//    assets, and other project content docs.
		//
		// At that point the queue doc is the only remaining pointer to the project
		// id whose content still exists. Use it here so the admin reset can force
		// that purge immediately instead of leaving the content for a later worker.
		// Then continue with the project docs that still exist.
		const queuedDefaultWorkspaceProjectRequest = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_workspace_scope", (q) => q.eq("workspaceId", defaultTenant.workspaceId).eq("scope", "project"))
			.first();
		if (
			queuedDefaultWorkspaceProjectRequest?.projectId &&
			queuedDefaultWorkspaceProjectRequest.projectId !== defaultTenant.defaultProjectId
		) {
			const queuedProjectPurge = await db_purge_workspace_project_content_batch(ctx, {
				workspaceId: defaultTenant.workspaceId,
				projectId: queuedDefaultWorkspaceProjectRequest.projectId,
				batchSize: batch_size(args),
			});
			if (!queuedProjectPurge.done) {
				return queuedProjectPurge;
			}

			await ctx.db.delete("data_deletion_requests", queuedDefaultWorkspaceProjectRequest._id);
			return { done: false, deletedCount: 1 };
		}

		const defaultWorkspaceProjects = await ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspace_default", (q) => q.eq("workspaceId", defaultTenant.workspaceId))
			.collect();
		// Extra projects under the personal workspace are user-owned data for this
		// reset flow. Leave only the primary home project behind.
		for (const project of defaultWorkspaceProjects) {
			if (project._id === defaultTenant.defaultProjectId || project.default) {
				// This is the home project doc we intentionally kept.
				continue;
			}

			const projectDelete = await db_delete_project_batch(ctx, {
				workspaceId: defaultTenant.workspaceId,
				projectId: project._id,
				batchSize: batch_size(args),
			});
			if (!projectDelete.done) {
				// The extra project still has content or structure left. Stop so the
				// caller can run another limited deletion step.
				return projectDelete;
			}

			// The extra personal project is gone, so release one project quota slot
			// from the personal workspace.
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
				usedCount: Math.max(0, quota.usedCount - 1),
				updatedAt: now,
			});
			// Delete at most one extra project doc and its related structure per call.
			return { done: false, deletedCount: 1 };
		}

		// Now review every non-default workspace connected to the user. Memberships
		// catch shared workspaces; ownership catches owned workspaces whose
		// membership docs may already have been removed by a prior deletion attempt.
		const memberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", user._id))
			.collect();
		const workspaceIdsToReview = new Set<Id<"workspaces">>();
		for (const membership of memberships) {
			if (membership.active === true && membership.workspaceId !== defaultTenant.workspaceId) {
				// Active membership means the user still has data or access in this
				// workspace, so the reset needs to inspect it.
				workspaceIdsToReview.add(membership.workspaceId);
			}
		}

		const ownedWorkspaces = await ctx.db
			.query("workspaces")
			.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", user._id))
			.collect();
		for (const workspace of ownedWorkspaces) {
			if (!workspace.default && workspace._id !== defaultTenant.workspaceId) {
				// Include extra workspaces still owned by this user. Account-deletion
				// setup can remove membership docs before this reset runs, but the
				// owner field still shows the workspace belongs to this user.
				workspaceIdsToReview.add(workspace._id);
			}
		}

		for (const workspaceId of workspaceIdsToReview) {
			const workspace = await ctx.db.get("workspaces", workspaceId);
			if (!workspace || workspace.default) {
				// Missing workspaces are already gone. Default workspaces are not part
				// of this non-default workspace cleanup.
				continue;
			}

			// Load projects so we can check whether anyone other than the reset user
			// still actively uses this workspace.
			const projects = await ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspace_default", (q) => q.eq("workspaceId", workspace._id))
				.collect();
			let hasOtherActiveUser = false;
			for (const project of projects) {
				// The index is ordered by user id, so checking one doc before and one
				// doc after the reset user is enough to know whether another active
				// user exists for this project.
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

			// Delete an owned non-default workspace only when no other active user
			// appears in any of its projects.
			if (workspace.ownerUserId === user._id && !hasOtherActiveUser) {
				const workspaceDelete = await db_delete_workspace_batch(ctx, {
					workspaceId: workspace._id,
					batchSize: batch_size(args),
				});
				if (!workspaceDelete.done) {
					// The workspace still has more docs than this call is allowed to delete.
					return workspaceDelete;
				}

				// The owned workspace with no other active users is gone. Clear stale
				// queue docs and release one workspace quota slot from the reset user.
				await db_delete_data_deletion_requests(ctx, {
					scope: "workspace",
					workspaceId: workspace._id,
				});
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
					usedCount: Math.max(0, quota.usedCount - 1),
					updatedAt: now,
				});
				// Delete at most one workspace doc and its related structure per call.
				return { done: false, deletedCount: 1 };
			}

			// In shared workspaces, preserve the workspace default `home` project and
			// only delete extra projects that have no active member other than the
			// reset user.
			for (const project of projects) {
				if (project.default || project._id === workspace.defaultProjectId) {
					// The workspace default project carries the workspace membership
					// roster. Keep it.
					continue;
				}

				// For non-default projects, delete only data that belongs solely to
				// the reset user. The project qualifies when the reset user is an
				// active project member or owns the workspace, and nobody else is an
				// active project member.
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
				// Skip when the reset user is neither an active member nor the
				// workspace owner, or when another active member still uses it.
				if ((!resetUserMembership && workspace.ownerUserId !== user._id) || activeUserBefore || activeUserAfter) {
					continue;
				}

				const projectDelete = await db_delete_project_batch(ctx, {
					workspaceId: workspace._id,
					projectId: project._id,
					batchSize: batch_size(args),
				});
				if (!projectDelete.done) {
					// The project still has more docs than this call is allowed to delete.
					return projectDelete;
				}

				// The extra project is gone, so release one project quota slot from
				// its workspace.
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
					usedCount: Math.max(0, quota.usedCount - 1),
					updatedAt: now,
				});
				// Delete at most one shared extra project doc and its related structure per call.
				return { done: false, deletedCount: 1 };
			}
		}

		// No reset-owned data was left to delete.
		return { done: true, deletedCount: 0 };
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

		// Queue immediate workspace deletions for workspaces that became empty
		// while finalizing this user.
		if (deleteUserRes?.workspacesToDelete) {
			for (const workspace of deleteUserRes.workspacesToDelete) {
				await data_deletion_db_request(ctx, {
					userId: user._id,
					workspaceId: workspace.workspaceId,
					scope: "workspace",
					eligibleAt: now,
				});
			}
		}

		await db_delete_data_deletion_requests(ctx, {
			scope: "user",
			userId: user._id,
		});

		return null;
	},
});

// #region data deletion orchestration

const DELETION_MUTATION_STEPS_PER_ACTION = 25;
const USER_DELETION_REQUEST_BATCH_SIZE = 20;
const WORKSPACE_DELETION_REQUEST_BATCH_SIZE = 50;
const PROJECT_DELETION_REQUEST_BATCH_SIZE = 200;

/**
 * Processes a limited number of eligible deletion requests.
 *
 * Requests run in order: users, workspaces, then projects. Each request deletes
 * one limited deletion step, so large deletes stay retryable and continue in later
 * Workpool jobs when `shouldReschedule` is true.
 */
async function run_deletion_request_batches(
	ctx: ActionCtx,
	args: {
		_test_now?: number;
		_test_batchSize?: number;
	},
) {
	const test_now = args._test_now;
	/**
	 * Number of request-processing mutations attempted by this worker run.
	 */
	let steps = 0;
	/**
	 * Whether the Workpool action should enqueue another run after this pass.
	 */
	let shouldReschedule = false;

	// Bound each worker run so a large deletion queue continues through follow-up Workpool jobs
	// without one action monopolizing the scheduler.
	while (steps < DELETION_MUTATION_STEPS_PER_ACTION) {
		let madeProgress = false;
		let hadFailure = false;

		const userRequestIds: Id<"data_deletion_requests">[] = await ctx.runQuery(
			internal.data_deletion.list_deletion_request_ids_by_scope,
			{ scope: "user", limit: USER_DELETION_REQUEST_BATCH_SIZE, _test_now: test_now },
		);
		shouldReschedule ||= userRequestIds.length >= USER_DELETION_REQUEST_BATCH_SIZE;

		// Process each request independently so one failed request does not stop the batch.
		// Count attempts, not only successful deletes, toward the per-run step budget.
		for (const requestId of userRequestIds) {
			try {
				const result = (await ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
					requestId,
					_test_now: test_now,
				})) as process_user_deletion_request_Result;
				madeProgress ||= result.deletedCount > 0 || result.done;
				shouldReschedule ||= !result.done;
			} catch (error) {
				hadFailure = true;
				shouldReschedule = true;
				console.error("Failed to process user deletion request", {
					error,
					requestId,
				});
			}

			// This request attempted one mutation, so it counts against this worker run.
			steps += 1;
			if (steps >= DELETION_MUTATION_STEPS_PER_ACTION) {
				break;
			}
		}

		// If user requests used the whole step budget, continue later before moving
		// on to lower-priority workspace/project requests.
		if (steps >= DELETION_MUTATION_STEPS_PER_ACTION) {
			shouldReschedule ||= userRequestIds.length > 0;
			break;
		}

		const workspaceRequestIds: Id<"data_deletion_requests">[] = await ctx.runQuery(
			internal.data_deletion.list_deletion_request_ids_by_scope,
			{
				scope: "workspace",
				limit: WORKSPACE_DELETION_REQUEST_BATCH_SIZE,
				_test_now: test_now,
			},
		);
		shouldReschedule ||= workspaceRequestIds.length >= WORKSPACE_DELETION_REQUEST_BATCH_SIZE;

		// Process each request independently so one failed request does not stop the batch.
		// Count attempts, not only successful deletes, toward the per-run step budget.
		for (const requestId of workspaceRequestIds) {
			try {
				const result = (await ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
					requestId,
					_test_batchSize: args._test_batchSize,
				})) as process_workspace_deletion_request_Result;
				madeProgress ||= result.deletedCount > 0 || result.done;
				shouldReschedule ||= !result.done;
			} catch (error) {
				hadFailure = true;
				shouldReschedule = true;
				console.error("Failed to process workspace deletion request", {
					error,
					requestId,
				});
			}

			// This request attempted one mutation, so it counts against this worker run.
			steps += 1;
			if (steps >= DELETION_MUTATION_STEPS_PER_ACTION) {
				break;
			}
		}

		// If workspace requests used the whole step budget, continue later before
		// moving on to lower-priority project requests.
		if (steps >= DELETION_MUTATION_STEPS_PER_ACTION) {
			shouldReschedule ||= workspaceRequestIds.length > 0;
			break;
		}

		const projectRequestIds: Id<"data_deletion_requests">[] = await ctx.runQuery(
			internal.data_deletion.list_deletion_request_ids_by_scope,
			{ scope: "project", limit: PROJECT_DELETION_REQUEST_BATCH_SIZE, _test_now: test_now },
		);
		shouldReschedule ||= projectRequestIds.length >= PROJECT_DELETION_REQUEST_BATCH_SIZE;

		// Process each request independently so one failed request does not stop the batch.
		// Count attempts, not only successful deletes, toward the per-run step budget.
		for (const requestId of projectRequestIds) {
			try {
				const result = (await ctx.runMutation(internal.data_deletion.process_project_deletion_request, {
					requestId,
					_test_batchSize: args._test_batchSize,
				})) as process_project_deletion_request_Result;
				madeProgress ||= result.deletedCount > 0 || result.done;
				shouldReschedule ||= !result.done;
			} catch (error) {
				hadFailure = true;
				shouldReschedule = true;
				console.error("Failed to process project deletion request", {
					error,
					requestId,
				});
			}

			// This request attempted one mutation, so it counts against this worker run.
			steps += 1;
			if (steps >= DELETION_MUTATION_STEPS_PER_ACTION) {
				break;
			}
		}

		// If project requests used the whole step budget, continue later. There
		// may be more project requests than this worker run was allowed to attempt.
		if (steps >= DELETION_MUTATION_STEPS_PER_ACTION) {
			shouldReschedule ||= projectRequestIds.length > 0;
			break;
		}

		// Stop when no request deleted data or finished in this pass. If a processor
		// threw, enqueue another run because the request doc stayed retryable.
		if (!madeProgress && !hadFailure) {
			shouldReschedule = false;
			break;
		}
		if (!madeProgress) {
			break;
		}
	}

	return { shouldReschedule, steps };
}

export const run_process_deletion_requests_once = internalAction({
	args: {
		/**
		 * Internal simulated wall time (ms) for listing and per-request mutations used by tests.
		 *
		 * Omit in normal production flows; downstream handlers use `Date.now()`.
		 */
		_test_now: v.optional(v.number()),
		_test_batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		shouldReschedule: v.boolean(),
		steps: v.number(),
	}),
	handler: async (ctx, args) => {
		return await run_deletion_request_batches(ctx, args);
	},
});

export const process_deletion_requests = internalAction({
	args: {
		/**
		 * Internal simulated wall time (ms) for listing and per-request mutations used by tests.
		 *
		 * Omit in normal production flows; downstream handlers use `Date.now()`.
		 */
		_test_now: v.optional(v.number()),
		_test_batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		shouldReschedule: v.boolean(),
		steps: v.number(),
	}),
	handler: async (ctx, args) => {
		const result = await run_deletion_request_batches(ctx, args);

		if (result.shouldReschedule && !args._test_disableReschedule) {
			await data_deletion_workpool.enqueueAction(ctx, internal.data_deletion.process_deletion_requests, args);
		}

		return result;
	},
});

export const enqueue_deletion_requests_processing = internalAction({
	args: {
		/**
		 * Internal simulated wall time (ms) for listing and per-request mutations used by tests.
		 *
		 * Omit in normal production flows; downstream handlers use `Date.now()`.
		 */
		_test_now: v.optional(v.number()),
		_test_batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await data_deletion_workpool.enqueueAction(ctx, internal.data_deletion.process_deletion_requests, args);

		return null;
	},
});

// #endregion data deletion orchestration
