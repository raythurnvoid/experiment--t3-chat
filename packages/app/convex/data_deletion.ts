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
import {
	organizations_DEFAULT_WORKSPACE_NAME,
	organizations_DEFAULT_ORGANIZATION_NAME,
} from "../shared/organizations.ts";
import {
	access_control_workspace_role_permission_grants,
	access_control_db_ensure_role_assignment,
	access_control_db_ensure_role_permission_grant,
	access_control_organization_role_permission_grants,
} from "./access_control.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_CONTENT_PURGE_BATCH_SIZE = 100;

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
 * Workspace purges use it to cancel outstanding jobs before deleting their
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
 * Workspace purges cancel those jobs before deleting the asset docs and R2
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
 * Workpool handle for plugin event-run executions.
 *
 * Workspace purges cancel queued runs before deleting their tracking docs.
 */
const plugins_runtime_workpool = new Workpool(components.plugins_runtime_workpool, {
	maxParallelism: 4,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 10 * 1000,
		base: 2,
		maxAttempts: 3,
	} as const,
});

/**
 * Workpool that runs the deletion request processor.
 *
 * It serializes user, organization, and workspace queue processing so large purges
 * advance through bounded retryable worker passes.
 */
const data_deletion_workpool = new Workpool(components.data_deletion_workpool, {
	maxParallelism: 1,
});

function batch_size(args: { _test_batchSize?: number }) {
	return Math.max(
		1,
		Math.min(args._test_batchSize ?? WORKSPACE_CONTENT_PURGE_BATCH_SIZE, WORKSPACE_CONTENT_PURGE_BATCH_SIZE),
	);
}

/**
 * Creates a deletion request, or updates the existing request for the same target.
 *
 * The same user, organization, or workspace should only have one queued request.
 * If the request already exists, keep the earlier processing time.
 */
export async function data_deletion_db_request(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId?: Id<"organizations">;
		workspaceId?: Id<"organizations_workspaces">;
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

	// Organization and workspace deletion requests must name the organization they belong to.
	if (!args.organizationId) {
		throw new Error("Organization id is required for organization/workspace deletion requests");
	}

	// Workspace deletion has one queue doc per organization/workspace pair.
	if (args.scope === "workspace") {
		if (!args.workspaceId) {
			throw new Error("Workspace id is required for workspace deletion requests");
		}

		const existingWorkspaceRequests = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_organization_workspace_scope", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("scope", "workspace"),
			)
			.first();

		if (existingWorkspaceRequests) {
			// Do not move an existing workspace deletion later.
			// Keep whichever request becomes eligible first.
			await ctx.db.patch("data_deletion_requests", existingWorkspaceRequests._id, {
				eligibleAt: Math.min(existingWorkspaceRequests.eligibleAt, eligibleAt),
			});
			return existingWorkspaceRequests._id;
		}

		return await ctx.db.insert("data_deletion_requests", {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			scope: "workspace",
			eligibleAt,
		});
	}

	// Organization deletion has one queue doc per organization. It is separate from
	// workspace requests in the same organization.
	const existingOrganizationRequest = await ctx.db
		.query("data_deletion_requests")
		.withIndex("by_organization_scope", (q) => q.eq("organizationId", args.organizationId).eq("scope", "organization"))
		.first();

	if (existingOrganizationRequest) {
		// Do not move an existing organization deletion later.
		// Keep whichever request becomes eligible first.
		await ctx.db.patch("data_deletion_requests", existingOrganizationRequest._id, {
			eligibleAt: Math.min(existingOrganizationRequest.eligibleAt, eligibleAt),
		});
		return existingOrganizationRequest._id;
	}

	return await ctx.db.insert("data_deletion_requests", {
		userId: args.userId,
		scope: "organization",
		organizationId: args.organizationId,
		eligibleAt,
	});
}

/**
 * Creates a new personal/default organization and home workspace for a user.
 *
 * This is used after membership cleanup leaves an existing user without their
 * default organization. Data reset paths do not silently repair a broken preserved
 * default tenant.
 */
async function db_create_default_organization_and_workspace_for_user(
	ctx: MutationCtx,
	args: { userId: Id<"users">; now: number },
) {
	// Create the parent organization before the default workspace so all child docs
	// can reference stable ids.
	const organizationId = await ctx.db.insert("organizations", {
		name: organizations_DEFAULT_ORGANIZATION_NAME,
		description: "",
		default: true,
		billingMode: "user",
		ownerUserId: args.userId,
		updatedAt: args.now,
	});

	const defaultWorkspaceId = await ctx.db.insert("organizations_workspaces", {
		organizationId,
		name: organizations_DEFAULT_WORKSPACE_NAME,
		description: "",
		default: true,
		updatedAt: args.now,
	});

	// Wire the new tenant together: default-workspace pointer, workspace quota,
	// active membership, owner role, and user default pointers.
	await Promise.all([
		ctx.db.patch("organizations", organizationId, {
			defaultWorkspaceId,
		}),
		quotas_db_ensure(ctx, {
			quotaName: "extra_workspaces",
			organizationId,
			now: args.now,
		}),
		ctx.db.insert("organizations_workspaces_users", {
			organizationId,
			workspaceId: defaultWorkspaceId,
			userId: args.userId,
			active: true,
			updatedAt: args.now,
		}),
		access_control_db_ensure_role_assignment(ctx, {
			organizationId,
			workspaceId: defaultWorkspaceId,
			userId: args.userId,
			role: "owner",
			now: args.now,
		}),
		ctx.db.patch("users", args.userId, {
			defaultOrganizationId: organizationId,
			defaultWorkspaceId,
		}),
	]);

	// Seed organization-level grants from the canonical role permission list.
	for (const grant of access_control_organization_role_permission_grants) {
		await access_control_db_ensure_role_permission_grant(ctx, {
			organizationId,
			workspaceId: defaultWorkspaceId,
			resourceKind: "organization",
			resourceId: String(organizationId),
			role: grant.role,
			permission: grant.permission,
			now: args.now,
		});
	}

	// Seed workspace-level grants for the default home workspace.
	for (const grant of access_control_workspace_role_permission_grants) {
		await access_control_db_ensure_role_permission_grant(ctx, {
			organizationId,
			workspaceId: defaultWorkspaceId,
			resourceKind: "workspace",
			resourceId: String(defaultWorkspaceId),
			role: grant.role,
			permission: grant.permission,
			now: args.now,
		});
	}

	return { organizationId, defaultWorkspaceId };
}

/**
 * Ensures membership cleanup does not leave an existing user without a default organization.
 */
async function db_ensure_default_organization_and_workspace_for_user(
	ctx: MutationCtx,
	args: { userId: Id<"users">; now: number },
) {
	const user = await ctx.db.get("users", args.userId);
	// Missing user docs are already-deleted accounts.
	if (!user) {
		return;
	}

	// Existing users with a missing default organization get a fresh
	// personal/default tenant.
	const defaultOrganization = user.defaultOrganizationId
		? await ctx.db.get("organizations", user.defaultOrganizationId)
		: null;
	if (!defaultOrganization) {
		await db_create_default_organization_and_workspace_for_user(ctx, args);
	}
}

/**
 * Deletes one limited set of workspace-owned content docs.
 *
 * Queue processors call this repeatedly. Each branch deletes one class of docs
 * and returns immediately so large workspaces stay within mutation limits.
 */
async function db_purge_organization_workspace_content_batch(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; batchSize: number },
) {
	const { organizationId, workspaceId, batchSize } = args;

	// Pending-update parent docs have cleanup-task, chunk, and metadata
	// children. Delete those children first, then delete the parent pending-update doc.
	const pendingUpdate = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_organization_workspace_user_fileNode", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
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

		const pendingPlainTextChunks = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", pendingUpdate._id))
			.take(batchSize);
		if (pendingPlainTextChunks.length > 0) {
			await Promise.all(pendingPlainTextChunks.map((doc) => ctx.db.delete("files_plain_text_chunks", doc._id)));
			return { done: false, deletedCount: pendingPlainTextChunks.length };
		}

		const markdownChunks = await ctx.db
			.query("files_markdown_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", pendingUpdate._id))
			.take(batchSize);
		if (markdownChunks.length > 0) {
			await Promise.all(markdownChunks.map((doc) => ctx.db.delete("files_markdown_chunks", doc._id)));
			return { done: false, deletedCount: markdownChunks.length };
		}

		const metadataDocs = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_pendingUpdate_qualifiedField", (q) => q.eq("pendingUpdateId", pendingUpdate._id))
			.take(batchSize);
		if (metadataDocs.length > 0) {
			await Promise.all(metadataDocs.map((doc) => ctx.db.delete("files_metadata_docs", doc._id)));
			return { done: false, deletedCount: metadataDocs.length };
		}

		await ctx.db.delete("files_pending_updates", pendingUpdate._id);
		return { done: false, deletedCount: 1 };
	}

	// Last-sequence docs are independent of pending-update parents but still
	// scoped to the workspace being purged.
	const lastSequenceSaved = await ctx.db
		.query("files_pending_updates_last_sequence_saved")
		.withIndex("by_organization_workspace_fileNode_user", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
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
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (aiFileContents.length > 0) {
		await Promise.all(aiFileContents.map((doc) => ctx.db.delete("ai_chat_files_content", doc._id)));
		return { done: false, deletedCount: aiFileContents.length };
	}

	const aiFiles = await ctx.db
		.query("ai_chat_files")
		.withIndex("by_organization_workspace_thread_path", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (aiFiles.length > 0) {
		await Promise.all(aiFiles.map((doc) => ctx.db.delete("ai_chat_files", doc._id)));
		return { done: false, deletedCount: aiFiles.length };
	}

	// AI thread messages and state are children of the thread docs, so they are
	// removed before deleting the thread docs themselves.
	const aiChatMessages = await ctx.db
		.query("ai_chat_threads_messages_aisdk_5")
		.withIndex("by_organization_workspace_thread", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (aiChatMessages.length > 0) {
		await Promise.all(aiChatMessages.map((doc) => ctx.db.delete("ai_chat_threads_messages_aisdk_5", doc._id)));
		return { done: false, deletedCount: aiChatMessages.length };
	}

	const aiChatThreadStates = await ctx.db
		.query("ai_chat_threads_state")
		.withIndex("by_organization_workspace_thread", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (aiChatThreadStates.length > 0) {
		await Promise.all(aiChatThreadStates.map((doc) => ctx.db.delete("ai_chat_threads_state", doc._id)));
		return { done: false, deletedCount: aiChatThreadStates.length };
	}

	const aiChatThreads = await ctx.db
		.query("ai_chat_threads")
		.withIndex("by_organization_workspace_archived_lastMessageAt", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (aiChatThreads.length > 0) {
		await Promise.all(aiChatThreads.map((doc) => ctx.db.delete("ai_chat_threads", doc._id)));
		return { done: false, deletedCount: aiChatThreads.length };
	}

	const apiCredentials = await ctx.db
		.query("api_credentials")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (apiCredentials.length > 0) {
		await Promise.all(apiCredentials.map((doc) => ctx.db.delete("api_credentials", doc._id)));
		return { done: false, deletedCount: apiCredentials.length };
	}

	const publicApiGrants = await ctx.db
		.query("public_api_grants")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (publicApiGrants.length > 0) {
		await Promise.all(publicApiGrants.map((doc) => ctx.db.delete("public_api_grants", doc._id)));
		return { done: false, deletedCount: publicApiGrants.length };
	}

	const pluginRunCalls = await ctx.db
		.query("plugins_event_run_calls")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (pluginRunCalls.length > 0) {
		await Promise.all(pluginRunCalls.map((doc) => ctx.db.delete("plugins_event_run_calls", doc._id)));
		return { done: false, deletedCount: pluginRunCalls.length };
	}

	// Plugin runs execute on the plugins-runtime workpool component; cancel
	// queued work before deleting the tracking docs.
	const pluginRuns = await ctx.db
		.query("plugins_event_runs")
		.withIndex("by_organization_workspace_updatedAt", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (pluginRuns.length > 0) {
		await Promise.all(
			pluginRuns.flatMap((doc) => (doc.workId ? [plugins_runtime_workpool.cancel(ctx, doc.workId)] : [])),
		);
		await Promise.all(pluginRuns.map((doc) => ctx.db.delete("plugins_event_runs", doc._id)));
		return { done: false, deletedCount: pluginRuns.length };
	}

	const pluginHandlers = await ctx.db
		.query("plugins_workspace_event_handlers")
		.withIndex("by_organization_workspace_installation", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (pluginHandlers.length > 0) {
		await Promise.all(pluginHandlers.map((doc) => ctx.db.delete("plugins_workspace_event_handlers", doc._id)));
		return { done: false, deletedCount: pluginHandlers.length };
	}

	const pluginSecrets = await ctx.db
		.query("plugins_workspace_installation_secrets")
		.withIndex("by_organization_workspace_installation", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (pluginSecrets.length > 0) {
		await Promise.all(pluginSecrets.map((doc) => ctx.db.delete("plugins_workspace_installation_secrets", doc._id)));
		return { done: false, deletedCount: pluginSecrets.length };
	}

	const pluginInstallations = await ctx.db
		.query("plugins_workspace_installations")
		.withIndex("by_organization_workspace_pluginName", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (pluginInstallations.length > 0) {
		await Promise.all(pluginInstallations.map((doc) => ctx.db.delete("plugins_workspace_installations", doc._id)));
		return { done: false, deletedCount: pluginInstallations.length };
	}

	// Legacy chat messages are still workspace-scoped content and are purged with
	// the same per-call deletion limit.
	const chatMessages = await ctx.db
		.query("chat_messages")
		.withIndex("by_organization_workspace_thread", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (chatMessages.length > 0) {
		await Promise.all(chatMessages.map((doc) => ctx.db.delete("chat_messages", doc._id)));
		return { done: false, deletedCount: chatMessages.length };
	}

	// File-derived content and snapshot docs are removed before jobs, assets,
	// and file nodes, which are cleaned up at the end of this helper.
	const metadataDocs = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (metadataDocs.length > 0) {
		await Promise.all(metadataDocs.map((doc) => ctx.db.delete("files_metadata_docs", doc._id)));
		return { done: false, deletedCount: metadataDocs.length };
	}

	const plainTextChunks = await ctx.db
		.query("files_plain_text_chunks")
		.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (plainTextChunks.length > 0) {
		await Promise.all(plainTextChunks.map((doc) => ctx.db.delete("files_plain_text_chunks", doc._id)));
		return { done: false, deletedCount: plainTextChunks.length };
	}

	const markdownChunks = await ctx.db
		.query("files_markdown_chunks")
		.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (markdownChunks.length > 0) {
		await Promise.all(markdownChunks.map((doc) => ctx.db.delete("files_markdown_chunks", doc._id)));
		return { done: false, deletedCount: markdownChunks.length };
	}

	const yjsSnapshots = await ctx.db
		.query("files_yjs_snapshots")
		.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (yjsSnapshots.length > 0) {
		await Promise.all(yjsSnapshots.map((doc) => ctx.db.delete("files_yjs_snapshots", doc._id)));
		return { done: false, deletedCount: yjsSnapshots.length };
	}

	const yjsUpdates = await ctx.db
		.query("files_yjs_updates")
		.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (yjsUpdates.length > 0) {
		await Promise.all(yjsUpdates.map((doc) => ctx.db.delete("files_yjs_updates", doc._id)));
		return { done: false, deletedCount: yjsUpdates.length };
	}

	const yjsLastSequences = await ctx.db
		.query("files_yjs_docs_last_sequences")
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (yjsLastSequences.length > 0) {
		await Promise.all(yjsLastSequences.map((doc) => ctx.db.delete("files_yjs_docs_last_sequences", doc._id)));
		return { done: false, deletedCount: yjsLastSequences.length };
	}

	const fileSnapshots = await ctx.db
		.query("files_snapshots")
		.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (fileSnapshots.length > 0) {
		await Promise.all(fileSnapshots.map((doc) => ctx.db.delete("files_snapshots", doc._id)));
		return { done: false, deletedCount: fileSnapshots.length };
	}

	const fileStats = await ctx.db
		.query("file_stats")
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (fileStats.length > 0) {
		await Promise.all(fileStats.map((doc) => ctx.db.delete("file_stats", doc._id)));
		return { done: false, deletedCount: fileStats.length };
	}

	// Cancel materialization jobs before deleting their tracking docs.
	const materializationJobs = await ctx.db
		.query("files_content_materialization_jobs")
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
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
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (assets.length > 0) {
		await Promise.all(
			assets.flatMap((asset) =>
				asset.processingWorkId ? [files_upload_conversion_workpool.cancel(ctx, asset.processingWorkId)] : [],
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
		.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
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
 * Organization and workspace deletion requests share resource indexes, so the final
 * filter below keeps one scope from consuming another scope's queue doc.
 */
async function db_delete_data_deletion_requests(
	ctx: MutationCtx,
	args:
		| { scope: "user"; userId: Id<"users"> }
		| { scope: "organization"; organizationId: Id<"organizations"> }
		| { scope: "workspace"; organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	// User deletion finalization only clears the user-scope queue doc.
	// Organization/workspace queue docs may still own tenant purge work.
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

	// Resource deletion cleanup is scoped by organization/workspace ids and then
	// filtered by explicit request scope so organization cleanup does not delete a
	// queued workspace purge.
	const docs = await ctx.db
		.query("data_deletion_requests")
		.withIndex(
			"by_organization_workspace",
			args.scope === "workspace"
				? (q) => q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId)
				: (q) => q.eq("organizationId", args.organizationId),
		)
		.collect();

	await Promise.all(
		docs
			.filter((doc) =>
				args.scope === "workspace"
					? doc.scope === "workspace"
					: doc.scope === "organization" && doc.workspaceId === undefined,
			)
			.map((doc) => ctx.db.delete("data_deletion_requests", doc._id)),
	);
}

/**
 * Deletes workspace structure after workspace content is gone.
 *
 * Each call removes one bounded class of docs so large workspace deletion remains
 * retryable across scheduled deletion worker runs.
 */
async function db_delete_workspace_structure_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		batchSize: number;
	},
) {
	// Remove user-facing workspace notifications before removing access docs and
	// the workspace doc itself.
	const notifications = await ctx.db
		.query("notifications")
		.withIndex("by_organization_workspace_user", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (notifications.length > 0) {
		await Promise.all(notifications.map((doc) => ctx.db.delete("notifications", doc._id)));
		return { done: false, deletedCount: notifications.length };
	}

	// Workspace memberships and direct access-control docs are structural state.
	// Heavy workspace content has already been purged before this helper runs.
	const memberships = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", args.workspaceId))
		.take(args.batchSize);
	if (memberships.length > 0) {
		await Promise.all(memberships.map((doc) => ctx.db.delete("organizations_workspaces_users", doc._id)));
		return { done: false, deletedCount: memberships.length };
	}

	const roleAssignments = await ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_organization_workspace_user_role", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (roleAssignments.length > 0) {
		await Promise.all(roleAssignments.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)));
		return { done: false, deletedCount: roleAssignments.length };
	}

	const permissionGrants = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_user_permission", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (permissionGrants.length > 0) {
		await Promise.all(permissionGrants.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)));
		return { done: false, deletedCount: permissionGrants.length };
	}

	// Delete the workspace doc last so retries can continue to target the same
	// workspace id until all child structure is gone.
	const workspace = await ctx.db.get("organizations_workspaces", args.workspaceId);
	if (workspace) {
		await ctx.db.delete("organizations_workspaces", workspace._id);
		return { done: true, deletedCount: 1 };
	}

	return { done: true, deletedCount: 0 };
}

/**
 * Runs workspace deletion in two phases: content first, then structure.
 */
async function db_delete_workspace_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		batchSize: number;
	},
) {
	const content = await db_purge_organization_workspace_content_batch(ctx, args);
	if (!content.done) {
		return content;
	}

	const structural = await db_delete_workspace_structure_batch(ctx, args);
	if (!structural.done) {
		return structural;
	}

	// The workspace queue doc is complete only after both content and structure
	// have been deleted.
	await db_delete_data_deletion_requests(ctx, {
		scope: "workspace",
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
	});

	return { done: true, deletedCount: content.deletedCount + structural.deletedCount };
}

/**
 * Deletes one bounded organization batch.
 *
 * Organization cleanup drains queued workspace-content purges first, then deletes
 * remaining workspace docs, organization-level structure, and finally the organization doc.
 */
async function db_delete_organization_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		batchSize: number;
	},
) {
	// An organization request may include workspace purge docs that outlive their
	// workspace docs. Drain those queued content purges before scanning workspaces.
	const queuedWorkspaceRequest = await ctx.db
		.query("data_deletion_requests")
		.withIndex("by_organization_scope", (q) => q.eq("organizationId", args.organizationId).eq("scope", "workspace"))
		.first();
	if (queuedWorkspaceRequest?.workspaceId) {
		const content = await db_purge_organization_workspace_content_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: queuedWorkspaceRequest.workspaceId,
			batchSize: args.batchSize,
		});
		if (!content.done) {
			return content;
		}

		await ctx.db.delete("data_deletion_requests", queuedWorkspaceRequest._id);
		return { done: false, deletedCount: 1 };
	}

	// Existing workspace docs still need full workspace deletion before organization
	// structure can be removed.
	const workspace = await ctx.db
		.query("organizations_workspaces")
		.withIndex("by_organization_default", (q) => q.eq("organizationId", args.organizationId))
		.first();
	if (workspace) {
		const result = await db_delete_workspace_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: workspace._id,
			batchSize: args.batchSize,
		});
		return result.done ? { done: false, deletedCount: result.deletedCount } : result;
	}

	// Once workspaces are gone, remove organization-level structure in bounded
	// chunks before deleting the organization doc.
	const notifications = await ctx.db
		.query("notifications")
		.withIndex("by_organization_user_read", (q) => q.eq("organizationId", args.organizationId))
		.take(args.batchSize);
	if (notifications.length > 0) {
		await Promise.all(notifications.map((doc) => ctx.db.delete("notifications", doc._id)));
		return { done: false, deletedCount: notifications.length };
	}

	const roleAssignments = await ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_organization_workspace_user_role", (q) => q.eq("organizationId", args.organizationId))
		.take(args.batchSize);
	if (roleAssignments.length > 0) {
		await Promise.all(roleAssignments.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)));
		return { done: false, deletedCount: roleAssignments.length };
	}

	const permissionGrants = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_user_permission", (q) => q.eq("organizationId", args.organizationId))
		.take(args.batchSize);
	if (permissionGrants.length > 0) {
		await Promise.all(permissionGrants.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)));
		return { done: false, deletedCount: permissionGrants.length };
	}

	const quotaDocs = await ctx.db
		.query("quotas")
		.withIndex("by_organization_quotaName", (q) => q.eq("organizationId", args.organizationId))
		.take(args.batchSize);
	if (quotaDocs.length > 0) {
		await Promise.all(quotaDocs.map((doc) => ctx.db.delete("quotas", doc._id)));
		return { done: false, deletedCount: quotaDocs.length };
	}

	// Delete the organization doc last so retries can continue to target the same
	// organization id until all scoped docs are gone.
	const organization = await ctx.db.get("organizations", args.organizationId);
	if (organization) {
		await ctx.db.delete("organizations", args.organizationId);
		return { done: true, deletedCount: 1 };
	}

	return { done: true, deletedCount: 0 };
}

/**
 * Phase 1 for an owned non-default organization during account deletion.
 *
 * The user-facing account deletion flow asks the owner to transfer or delete
 * owned organizations first. Internal/admin deletion paths can still reach this
 * helper with an owned organization. In that case, queue the organization for the
 * phase-2 purge worker, remove access docs and memberships immediately, and
 * release the owner's organization quota slot. The organization/workspace docs and
 * heavy content are left for the queued organization purge.
 */
async function db_queue_organization_deletion_for_owner_account_deletion(
	ctx: MutationCtx,
	args: {
		organizationOwnerUserId: Id<"users">;
		organization: Doc<"organizations">;
		now: number;
	},
) {
	// Do the immediate organization cleanup in parallel:
	// - create or reuse the organization-scope queue doc;
	// - remove role and permission docs so the organization is no longer usable;
	// - remove workspace memberships and keep the affected user ids for default
	//   tenant checks below.
	const [, , , userIdsPerWorkspace] = await Promise.all([
		data_deletion_db_request(ctx, {
			userId: args.organizationOwnerUserId,
			organizationId: args.organization._id,
			scope: "organization",
		}),
		ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_organization_workspace_user_role", (q) => q.eq("organizationId", args.organization._id))
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)))),
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_user_permission", (q) =>
				q.eq("organizationId", args.organization._id),
			)
			.collect()
			.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)))),
		ctx.db
			.query("organizations_workspaces")
			.withIndex("by_organization_default", (q) => q.eq("organizationId", args.organization._id))
			.collect()
			.then((organizationWorkspaces) =>
				Promise.all(
					organizationWorkspaces.map(async (workspace) => {
						const workspaceUsers = await ctx.db
							.query("organizations_workspaces_users")
							.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", workspace._id))
							.collect();

						await Promise.all(
							workspaceUsers.map((workspaceUser) => ctx.db.delete("organizations_workspaces_users", workspaceUser._id)),
						);

						return workspaceUsers.map((workspaceUser) => workspaceUser.userId);
					}),
				),
			),
	]);

	// The owner consumed one `extra_organizations` quota slot for this organization.
	// Release it now because the organization is already queued for deletion and no
	// longer usable by members.
	const quota = await quotas_db_get(ctx, {
		quotaName: "extra_organizations",
		userId: args.organizationOwnerUserId,
	});
	if (quota.usedCount > 0) {
		await ctx.db.patch("quotas", quota._id, {
			usedCount: quota.usedCount - 1,
			updatedAt: args.now,
		});
	}

	// Removing memberships can leave affected users without a usable default
	// tenant if this organization was their only remaining organization. Re-check each
	// affected user after membership removal.
	for (const userId of new Set<Id<"users">>(userIdsPerWorkspace.flat())) {
		await db_ensure_default_organization_and_workspace_for_user(ctx, {
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
		.query("organizations_workspaces_users")
		.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", args.user._id))
		.collect();

	// A repeated phase-1 call is idempotent. Once `deletedAt` is set, do not
	// rewrite memberships again.
	if (args.user.deletedAt == null) {
		// Tombstone the user and deactivate memberships so phase 1 stays
		// reversible while phase 2 still has the affected tenants available.
		await Promise.all(
			memberships.map((membership) =>
				ctx.db.patch("organizations_workspaces_users", membership._id, {
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
 * Organization/workspace content is not deleted here. Instead, this returns the
 * organization ids that became empty so the caller can queue or run organization purge
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
	// Pending-update parent docs have cleanup-task, chunk, and metadata
	// children. Gather those children before deletion so they can be deleted before their parent docs.
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
		pendingMarkdownChunks,
		pendingPlainTextChunks,
		pendingMetadataDocs,
		lastSequenceSaved,
		apiCredentials,
		publicApiGrants,
		billingUsageSnapshots,
		publisherRepositories,
		publisherSecrets,
		publisherVersionReviews,
	] = await Promise.all([
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", user._id))
			.collect(),
		ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_user_role_organization_workspace", (q) => q.eq("userId", user._id))
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
							.query("files_markdown_chunks")
							.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", doc._id))
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
							.query("files_plain_text_chunks")
							.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", doc._id))
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
							.query("files_metadata_docs")
							.withIndex("by_pendingUpdate_qualifiedField", (q) => q.eq("pendingUpdateId", doc._id))
							.collect(),
					),
				)
			).flat(),
		),
		ctx.db
			.query("files_pending_updates_last_sequence_saved")
			.withIndex("by_user_fileNode", (q) => q.eq("userId", userIdString))
			.collect(),
		ctx.db
			.query("api_credentials")
			.withIndex("by_user", (q) => q.eq("userId", user._id))
			.collect(),
		ctx.db
			.query("public_api_grants")
			.withIndex("by_user", (q) => q.eq("userId", user._id))
			.collect(),
		args.deleteBillingState
			? ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", user._id))
					.collect()
			: Promise.resolve([] as Array<Doc<"billing_usage_snapshots">>),
		ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_ownerUser_repositoryUrl", (q) => q.eq("ownerUserId", user._id))
			.collect(),
		ctx.db
			.query("plugins_publisher_repository_secrets")
			.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", user._id))
			.collect(),
		ctx.db
			.query("plugins_version_reviews")
			.withIndex("by_createdBy_pluginName", (q) => q.eq("createdBy", user._id))
			.collect(),
	]);

	/**
	 * Organization ids captured before deleting memberships and roles, used after cleanup
	 * to detect organizations that no longer have any active members.
	 */
	const affectedOrganizationIds = new Set<Id<"organizations">>();
	if (user.defaultOrganizationId) {
		affectedOrganizationIds.add(user.defaultOrganizationId);
	}
	for (const membership of membershipsAll) {
		affectedOrganizationIds.add(membership.organizationId);
	}
	for (const assignment of accessRoleAssignments) {
		affectedOrganizationIds.add(assignment.organizationId);
	}

	// Delete pending-update children before parent pending-update docs.
	const [directPermissionGrants, userQuotaDocs] = await Promise.all([
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_user_organization_workspace_resource_permission", (q) => q.eq("userId", user._id))
			.collect(),
		ctx.db
			.query("quotas")
			.withIndex("by_user_quotaName", (q) => q.eq("userId", user._id))
			.collect(),
		Promise.all([
			...pendingPlainTextChunks.map((doc) => ctx.db.delete("files_plain_text_chunks", doc._id)),
			...pendingUpdateCleanupTasks.map((doc) => ctx.db.delete("files_pending_updates_cleanup_tasks", doc._id)),
			...pendingMarkdownChunks.map((doc) => ctx.db.delete("files_markdown_chunks", doc._id)),
			...pendingMetadataDocs.map((doc) => ctx.db.delete("files_metadata_docs", doc._id)),
			...publisherRepositories.map((doc) => ctx.db.delete("plugins_publisher_repositories", doc._id)),
			...publisherSecrets.map((doc) => ctx.db.delete("plugins_publisher_repository_secrets", doc._id)),
			...publisherVersionReviews.map((doc) => ctx.db.delete("plugins_version_reviews", doc._id)),
		]),
	]);

	await Promise.all([
		...lastSequenceSaved.map((doc) => ctx.db.delete("files_pending_updates_last_sequence_saved", doc._id)),
		...pendingUpdates.map((doc) => ctx.db.delete("files_pending_updates", doc._id)),
		// Remove membership and role docs so the finalized user no longer has access
		// to any workspace or organization.
		...membershipsAll.map((doc) => ctx.db.delete("organizations_workspaces_users", doc._id)),
		...accessRoleAssignments.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)),
		// Remove direct permission grants for this user. Role grants are handled by
		// organization/workspace cleanup; this query targets user-principal grants.
		...directPermissionGrants.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)),
		...apiCredentials.map((doc) => ctx.db.delete("api_credentials", doc._id)),
		...publicApiGrants.map((doc) => ctx.db.delete("public_api_grants", doc._id)),
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
			defaultOrganizationId: undefined,
			defaultWorkspaceId: undefined,
			deletedAt: user.deletedAt ?? args.now,
		}),
	]);

	const organizationsToDelete = [];

	// Return only fully empty organizations here. The caller owns the actual
	// organization purge so it can keep the surrounding request bookkeeping local.
	for (const organizationId of affectedOrganizationIds) {
		const organization = await ctx.db.get("organizations", organizationId);
		if (!organization) {
			continue;
		}

		const remainingMemberships = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_organization_workspace_user", (q) =>
				q.eq("active", true).eq("organizationId", organizationId),
			)
			.first();
		if (remainingMemberships) {
			continue;
		}

		organizationsToDelete.push({
			organizationId: organization._id,
		});
	}
	return { organizationsToDelete };
}

/**
 * Starts account deletion phase 1 and creates the user-scope queue doc.
 *
 * Still-owned non-default organizations are queued before the user tombstone, so
 * restoring the user during retention does not restore those organization deletions.
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
		// owns non-default organizations. Queue those organizations for phase 2 first.
		const ownedOrganizations = await ctx.db
			.query("organizations")
			.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", args.userId))
			.collect();

		for (const organization of ownedOrganizations.filter((organization) => !organization.default)) {
			// This removes access immediately and leaves organization content for the
			// organization-scope purge worker.
			await db_queue_organization_deletion_for_owner_account_deletion(ctx, {
				organizationOwnerUserId: user._id,
				organization,
				now,
			});
		}

		// Keep phase 1 reversible for the account itself. Owned organizations that
		// remain after any frontend transfer calls are queued for deletion here,
		// so restoring the account does not recover those organization deletions.
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
 * The worker calls this separately for users, organizations, and workspaces so the
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
		 * and now-eligible organization requests created while processing the user.
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
		// compute which organizations became fully empty at the retention boundary.
		const deleteUserRes = await db_finalize_deleted_user(ctx, {
			userId: user._id,
			now: now,
		});

		// Queue immediate organization deletions for organizations that became empty while
		// finalizing this user.
		if (deleteUserRes?.organizationsToDelete) {
			for (const organization of deleteUserRes.organizationsToDelete) {
				await data_deletion_db_request(ctx, {
					userId: request.userId,
					organizationId: organization.organizationId,
					scope: "organization",
					eligibleAt: now,
				});
			}
		}

		// User finalization and follow-up organization queueing are complete.
		await ctx.db.delete("data_deletion_requests", request._id);

		return { done: true, deletedCount: 1 };
	},
});

type process_user_deletion_request_Result =
	typeof process_user_deletion_request extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Process one queued organization-scope deletion.
 *
 * The caller must only pass request docs whose `eligibleAt` has passed.
 */
export const process_organization_deletion_request = internalMutation({
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

		// This mutation only owns organization-scope requests.
		if (request.scope !== "organization") {
			return { done: true, deletedCount: 0 };
		}

		const organizationId = request.organizationId;

		// An organization request without an organization id cannot target organization docs.
		// Remove the invalid queue doc instead of retrying forever.
		if (!organizationId) {
			await ctx.db.delete("data_deletion_requests", request._id);
			return { done: true, deletedCount: 1 };
		}

		// Delete only a limited number of docs for this organization. If content or
		// structure remains, keep the request doc so the next worker run continues.
		const result = await db_delete_organization_batch(ctx, {
			organizationId,
			batchSize: batch_size(args),
		});

		// No-progress incomplete results should be rare. Log them so the queue does
		// not silently loop without deleting docs.
		if (!result.done) {
			if (result.deletedCount === 0) {
				console.error("Deletion request made no progress", {
					scope: "organization",
					requestId: request._id,
				});
			}
			return result;
		}

		// All covered organization content and structure is gone, so the queue doc is complete.
		await ctx.db.delete("data_deletion_requests", request._id);

		return { done: true, deletedCount: 1 };
	},
});

type process_organization_deletion_request_Result =
	typeof process_organization_deletion_request extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
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

		// A workspace request without both ids cannot target workspace content.
		// Remove the invalid queue doc instead of retrying forever.
		if (!request.organizationId || !request.workspaceId) {
			await ctx.db.delete("data_deletion_requests", request._id);
			return { done: true, deletedCount: 1 };
		}

		// Delete only a limited number of docs for this workspace. If content remains,
		// keep the request doc so the next worker run continues from the same scope.
		const result = await db_purge_organization_workspace_content_batch(ctx, {
			organizationId: request.organizationId,
			workspaceId: request.workspaceId,
			batchSize: batch_size(args),
		});
		if (!result.done) {
			if (result.deletedCount === 0) {
				console.error("Deletion request made no progress", {
					scope: "workspace",
					requestId: request._id,
				});
			}
			return result;
		}

		// All covered workspace content is gone, so this queue doc is complete.
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

// #region admin hard deletion

/**
 * Internal admin data-reset entrypoint.
 *
 * Used by `users.hard_delete_user_now` for `purgeUserMod: "data"`. It removes
 * reset-owned data without deleting the account. It keeps the `users` doc, auth
 * ids, profile, billing state, and default tenant: the `personal` organization
 * plus the `home` workspace.
 *
 * Each call deletes only a limited number of docs, so callers should invoke it
 * again when it returns `done: false`.
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

		// The app expects every usable account to have an organization quota doc.
		// Ensure it before we reuse the user's default organization.
		await quotas_db_ensure(ctx, {
			quotaName: "extra_organizations",
			userId: user._id,
			now,
		});

		// Try to load the user's current default tenant from the pointers cached on
		// the user doc. This should normally be the personal organization and home workspace.
		const [organization, workspace] =
			user.defaultOrganizationId && user.defaultWorkspaceId
				? await Promise.all([
						ctx.db.get("organizations", user.defaultOrganizationId),
						ctx.db.get("organizations_workspaces", user.defaultWorkspaceId),
					])
				: [null, null];
		// We also need a membership doc for the default workspace. Without it, the UI
		// cannot resolve the user's personal/home route after the reset.
		const membership =
			organization && workspace
				? await ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_user_organization_workspace_active", (q) =>
							q.eq("userId", user._id).eq("organizationId", organization._id).eq("workspaceId", workspace._id),
						)
						.first()
				: null;
		let defaultTenant: { organizationId: Id<"organizations">; defaultWorkspaceId: Id<"organizations_workspaces"> };

		// Reuse the existing default tenant. First ensure its workspace quota doc;
		// then below ensure the membership, owner role, and grant docs that make
		// the default organization/workspace usable after reset.
		if (
			organization?.default &&
			workspace &&
			workspace.organizationId === organization._id &&
			organization.defaultWorkspaceId === workspace._id &&
			workspace.default &&
			membership
		) {
			await quotas_db_ensure(ctx, {
				quotaName: "extra_workspaces",
				organizationId: organization._id,
				now,
			});

			// Check for an active default-workspace membership doc directly. A broad
			// `first()` could return an inactive doc even when an active one exists.
			const activeMembership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", user._id)
						.eq("organizationId", organization._id)
						.eq("workspaceId", workspace._id),
				)
				.first();

			// If no active default-workspace membership exists, reactivate one
			// inactive doc for this same user/organization/workspace instead of
			// creating a duplicate.
			if (!activeMembership) {
				const inactiveMembership = await ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_user_organization_workspace_active", (q) =>
						q
							.eq("userId", user._id)
							.eq("organizationId", organization._id)
							.eq("workspaceId", workspace._id)
							.eq("active", false),
					)
					.first();

				// The user had this default-workspace membership, but it was
				// deactivated during deletion setup. Mark it active again so the
				// user can open the personal/home workspace after the reset.
				if (inactiveMembership) {
					await ctx.db.patch("organizations_workspaces_users", inactiveMembership._id, {
						active: true,
						updatedAt: now,
					});
				} else {
					const errorMessage = "Default tenant exists without a default-workspace membership doc during data reset";
					const errorData = {
						userId: user._id,
						organizationId: organization._id,
						workspaceId: workspace._id,
					};
					console.error(errorMessage, errorData);
					throw should_never_happen(errorMessage, errorData);
					// await ctx.db.insert("organizations_workspaces_users", {
					// 	organizationId: organization._id,
					// 	workspaceId: workspace._id,
					// 	userId: user._id,
					// 	active: true,
					// 	updatedAt: now,
					// });
				}
			}

			// The user must remain owner of their personal/home workspace after reset.
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: organization._id,
				workspaceId: workspace._id,
				userId: user._id,
				role: "owner",
				now,
			});

			// Re-seed organization-level grants. The helper is idempotent, so existing
			// grants are reused and missing grants are recreated.
			for (const grant of access_control_organization_role_permission_grants) {
				await access_control_db_ensure_role_permission_grant(ctx, {
					organizationId: organization._id,
					workspaceId: workspace._id,
					resourceKind: "organization",
					resourceId: String(organization._id),
					role: grant.role,
					permission: grant.permission,
					now,
				});
			}

			// Re-seed workspace-level grants for the home workspace.
			for (const grant of access_control_workspace_role_permission_grants) {
				await access_control_db_ensure_role_permission_grant(ctx, {
					organizationId: organization._id,
					workspaceId: workspace._id,
					resourceKind: "workspace",
					resourceId: String(workspace._id),
					role: grant.role,
					permission: grant.permission,
					now,
				});
			}
			// Everything below must preserve these default organization/workspace docs.
			defaultTenant = {
				organizationId: organization._id,
				defaultWorkspaceId: workspace._id,
			};
		} else {
			const errorMessage = "Default tenant is missing or inconsistent during data reset";
			const errorData = {
				userId: user._id,
				defaultOrganizationId: user.defaultOrganizationId,
				defaultWorkspaceId: user.defaultWorkspaceId,
				organizationFound: Boolean(organization),
				organizationDefault: organization?.default,
				organizationDefaultWorkspaceId: organization?.defaultWorkspaceId,
				workspaceFound: Boolean(workspace),
				workspaceDefault: workspace?.default,
				workspaceOrganizationId: workspace?.organizationId,
				membershipFound: Boolean(membership),
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
			// Previous repair fallback, intentionally kept commented while we verify
			// this invariant in tests/logs. Do not re-enable without deciding that
			// missing default tenant docs should be repaired during data reset.
			// const created = await db_create_default_organization_and_workspace_for_user(ctx, {
			// 	userId: user._id,
			// 	now,
			// });
			// defaultTenant = {
			// 	organizationId: created.organizationId,
			// 	defaultWorkspaceId: created.defaultWorkspaceId,
			// };
		}

		// Commit the usable account state before deleting data. This keeps auth,
		// profile, and billing state intact while making sure the user points to
		// the default organization/workspace selected above.
		await Promise.all([
			// Clear `deletedAt` because a data reset should leave the account usable,
			// even if it started from a tombstoned state.
			ctx.db.patch("users", user._id, {
				defaultOrganizationId: defaultTenant.organizationId,
				defaultWorkspaceId: defaultTenant.defaultWorkspaceId,
				deletedAt: undefined,
			}),
			// Cancel the user-scope deletion request. Resource-scope requests must stay
			// queued until this reset either consumes them or proves they target the
			// preserved default organization/workspace.
			db_delete_data_deletion_requests(ctx, {
				scope: "user",
				userId: user._id,
			}),
		]);

		// The personal/home workspace is the one workspace we keep. Purge only its
		// content docs so the user opens a clean home workspace after reset.
		const defaultWorkspacePurge = await db_purge_organization_workspace_content_batch(ctx, {
			organizationId: defaultTenant.organizationId,
			workspaceId: defaultTenant.defaultWorkspaceId,
			batchSize: batch_size(args),
		});
		if (!defaultWorkspacePurge.done) {
			// The home workspace still has more content than fits in this batch.
			return defaultWorkspacePurge;
		}
		await Promise.all([
			// The default tenant must not be deleted later by an old queued request.
			db_delete_data_deletion_requests(ctx, {
				scope: "organization",
				organizationId: defaultTenant.organizationId,
			}),
			db_delete_data_deletion_requests(ctx, {
				scope: "workspace",
				organizationId: defaultTenant.organizationId,
				workspaceId: defaultTenant.defaultWorkspaceId,
			}),
		]);

		// Admin data reset can run after workspace deletion phase 1 but before the
		// queued background purge finishes phase 2:
		//
		// 1. `delete_workspace` has already queued a workspace-scope request.
		// 2. `delete_workspace` has already deleted the `organizations_workspaces` doc,
		//    so scanning workspace docs below will not find this workspace anymore.
		// 3. The queued purge has not yet deleted that workspace's files, threads,
		//    assets, and other workspace content docs.
		//
		// At that point the queue doc is the only remaining pointer to the workspace
		// id whose content still exists. Use it here so the admin reset can force
		// that purge immediately instead of leaving the content for a later worker.
		// Then continue with the workspace docs that still exist.
		const queuedDefaultOrganizationWorkspaceRequest = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_organization_scope", (q) =>
				q.eq("organizationId", defaultTenant.organizationId).eq("scope", "workspace"),
			)
			.first();
		if (
			queuedDefaultOrganizationWorkspaceRequest?.workspaceId &&
			queuedDefaultOrganizationWorkspaceRequest.workspaceId !== defaultTenant.defaultWorkspaceId
		) {
			const queuedWorkspacePurge = await db_purge_organization_workspace_content_batch(ctx, {
				organizationId: defaultTenant.organizationId,
				workspaceId: queuedDefaultOrganizationWorkspaceRequest.workspaceId,
				batchSize: batch_size(args),
			});
			if (!queuedWorkspacePurge.done) {
				return queuedWorkspacePurge;
			}

			await ctx.db.delete("data_deletion_requests", queuedDefaultOrganizationWorkspaceRequest._id);
			return { done: false, deletedCount: 1 };
		}

		const defaultOrganizationWorkspaces = await ctx.db
			.query("organizations_workspaces")
			.withIndex("by_organization_default", (q) => q.eq("organizationId", defaultTenant.organizationId))
			.collect();
		// Extra workspaces under the personal organization are user-owned data for this
		// reset flow. Leave only the primary home workspace behind.
		for (const workspace of defaultOrganizationWorkspaces) {
			if (workspace._id === defaultTenant.defaultWorkspaceId || workspace.default) {
				// This is the home workspace doc we intentionally kept.
				continue;
			}

			const workspaceDelete = await db_delete_workspace_batch(ctx, {
				organizationId: defaultTenant.organizationId,
				workspaceId: workspace._id,
				batchSize: batch_size(args),
			});
			if (!workspaceDelete.done) {
				// The extra workspace still has content or structure left. Stop so the
				// caller can run another limited deletion step.
				return workspaceDelete;
			}

			// The extra personal workspace is gone, so release one workspace quota slot
			// from the personal organization.
			await quotas_db_ensure(ctx, {
				quotaName: "extra_workspaces",
				organizationId: defaultTenant.organizationId,
				now,
			});
			const quota = await quotas_db_get(ctx, {
				quotaName: "extra_workspaces",
				organizationId: defaultTenant.organizationId,
			});
			await ctx.db.patch("quotas", quota._id, {
				usedCount: Math.max(0, quota.usedCount - 1),
				updatedAt: now,
			});
			// Delete at most one extra workspace doc and its related structure per call.
			return { done: false, deletedCount: 1 };
		}

		// Now review every non-default organization connected to the user. Memberships
		// catch shared organizations; ownership catches owned organizations whose
		// membership docs may already have been removed by a prior deletion attempt.
		const memberships = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", user._id))
			.collect();
		const organizationIdsToReview = new Set<Id<"organizations">>();
		for (const membership of memberships) {
			if (membership.active === true && membership.organizationId !== defaultTenant.organizationId) {
				// Active membership means the user still has data or access in this
				// organization, so the reset needs to inspect it.
				organizationIdsToReview.add(membership.organizationId);
			}
		}

		const ownedOrganizations = await ctx.db
			.query("organizations")
			.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", user._id))
			.collect();
		for (const organization of ownedOrganizations) {
			if (!organization.default && organization._id !== defaultTenant.organizationId) {
				// Include extra organizations still owned by this user. Account-deletion
				// setup can remove membership docs before this reset runs, but the
				// owner field still shows the organization belongs to this user.
				organizationIdsToReview.add(organization._id);
			}
		}

		for (const organizationId of organizationIdsToReview) {
			const organization = await ctx.db.get("organizations", organizationId);
			if (!organization || organization.default) {
				// Missing organizations are already gone. Default organizations are not part
				// of this non-default organization cleanup.
				continue;
			}

			// Load workspaces so we can check whether anyone other than the reset user
			// still actively uses this organization.
			const workspaces = await ctx.db
				.query("organizations_workspaces")
				.withIndex("by_organization_default", (q) => q.eq("organizationId", organization._id))
				.collect();
			let hasOtherActiveUser = false;
			for (const workspace of workspaces) {
				// The index is ordered by user id, so checking one doc before and one
				// doc after the reset user is enough to know whether another active
				// user exists for this workspace.
				const [activeUserBefore, activeUserAfter] = await Promise.all([
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_active_organization_workspace_user", (q) =>
							q
								.eq("active", true)
								.eq("organizationId", organization._id)
								.eq("workspaceId", workspace._id)
								.lt("userId", user._id),
						)
						.first(),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_active_organization_workspace_user", (q) =>
							q
								.eq("active", true)
								.eq("organizationId", organization._id)
								.eq("workspaceId", workspace._id)
								.gt("userId", user._id),
						)
						.first(),
				]);
				if (activeUserBefore || activeUserAfter) {
					hasOtherActiveUser = true;
					break;
				}
			}

			// Delete an owned non-default organization only when no other active user
			// appears in any of its workspaces.
			if (organization.ownerUserId === user._id && !hasOtherActiveUser) {
				const organizationDelete = await db_delete_organization_batch(ctx, {
					organizationId: organization._id,
					batchSize: batch_size(args),
				});
				if (!organizationDelete.done) {
					// The organization still has more docs than this call is allowed to delete.
					return organizationDelete;
				}

				// The owned organization with no other active users is gone. Clear stale
				// queue docs and release one organization quota slot from the reset user.
				await db_delete_data_deletion_requests(ctx, {
					scope: "organization",
					organizationId: organization._id,
				});
				await quotas_db_ensure(ctx, {
					quotaName: "extra_organizations",
					userId: user._id,
					now,
				});
				const quota = await quotas_db_get(ctx, {
					quotaName: "extra_organizations",
					userId: user._id,
				});
				await ctx.db.patch("quotas", quota._id, {
					usedCount: Math.max(0, quota.usedCount - 1),
					updatedAt: now,
				});
				// Delete at most one organization doc and its related structure per call.
				return { done: false, deletedCount: 1 };
			}

			// In shared organizations, preserve the organization default `home` workspace and
			// only delete extra workspaces that have no active member other than the
			// reset user.
			for (const workspace of workspaces) {
				if (workspace.default || workspace._id === organization.defaultWorkspaceId) {
					// The organization default workspace carries the organization membership
					// roster. Keep it.
					continue;
				}

				// For non-default workspaces, delete only data that belongs solely to
				// the reset user. The workspace qualifies when the reset user is an
				// active workspace member or owns the organization, and nobody else is an
				// active workspace member.
				const [resetUserMembership, activeUserBefore, activeUserAfter] = await Promise.all([
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_active_user_organization_workspace", (q) =>
							q
								.eq("active", true)
								.eq("userId", user._id)
								.eq("organizationId", organization._id)
								.eq("workspaceId", workspace._id),
						)
						.first(),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_active_organization_workspace_user", (q) =>
							q
								.eq("active", true)
								.eq("organizationId", organization._id)
								.eq("workspaceId", workspace._id)
								.lt("userId", user._id),
						)
						.first(),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_active_organization_workspace_user", (q) =>
							q
								.eq("active", true)
								.eq("organizationId", organization._id)
								.eq("workspaceId", workspace._id)
								.gt("userId", user._id),
						)
						.first(),
				]);
				// Skip when the reset user is neither an active member nor the
				// organization owner, or when another active member still uses it.
				if ((!resetUserMembership && organization.ownerUserId !== user._id) || activeUserBefore || activeUserAfter) {
					continue;
				}

				const workspaceDelete = await db_delete_workspace_batch(ctx, {
					organizationId: organization._id,
					workspaceId: workspace._id,
					batchSize: batch_size(args),
				});
				if (!workspaceDelete.done) {
					// The workspace still has more docs than this call is allowed to delete.
					return workspaceDelete;
				}

				// The extra workspace is gone, so release one workspace quota slot from
				// its organization.
				await quotas_db_ensure(ctx, {
					quotaName: "extra_workspaces",
					organizationId: organization._id,
					now,
				});
				const quota = await quotas_db_get(ctx, {
					quotaName: "extra_workspaces",
					organizationId: organization._id,
				});
				await ctx.db.patch("quotas", quota._id, {
					usedCount: Math.max(0, quota.usedCount - 1),
					updatedAt: now,
				});
				// Delete at most one shared extra workspace doc and its related structure per call.
				return { done: false, deletedCount: 1 };
			}
		}

		// No reset-owned data was left to delete.
		return { done: true, deletedCount: 0 };
	},
});

/**
 * Internal admin finalization entrypoint for auth-removing hard-delete modes.
 *
 * This runs the user tombstone and finalization immediately instead of waiting
 * for the retained user-scope queue doc. It may preserve or remove auth and
 * billing state depending on the caller's mode, then queues any newly empty
 * organizations for immediate phase-2 purge.
 */
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

		// Queue immediate organization deletions for organizations that became empty
		// while finalizing this user.
		if (deleteUserRes?.organizationsToDelete) {
			for (const organization of deleteUserRes.organizationsToDelete) {
				await data_deletion_db_request(ctx, {
					userId: user._id,
					organizationId: organization.organizationId,
					scope: "organization",
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

// #endregion admin hard deletion

// #region data deletion orchestration

const DELETION_MUTATION_STEPS_PER_ACTION = 25;
const USER_DELETION_REQUEST_BATCH_SIZE = 20;
const ORGANIZATION_DELETION_REQUEST_BATCH_SIZE = 50;
const WORKSPACE_DELETION_REQUEST_BATCH_SIZE = 200;

/**
 * Processes a limited number of eligible deletion requests.
 *
 * Requests run in order: users, organizations, then workspaces. Each request deletes
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
		// on to lower-priority organization/workspace requests.
		if (steps >= DELETION_MUTATION_STEPS_PER_ACTION) {
			shouldReschedule ||= userRequestIds.length > 0;
			break;
		}

		const organizationRequestIds: Id<"data_deletion_requests">[] = await ctx.runQuery(
			internal.data_deletion.list_deletion_request_ids_by_scope,
			{
				scope: "organization",
				limit: ORGANIZATION_DELETION_REQUEST_BATCH_SIZE,
				_test_now: test_now,
			},
		);
		shouldReschedule ||= organizationRequestIds.length >= ORGANIZATION_DELETION_REQUEST_BATCH_SIZE;

		// Process each request independently so one failed request does not stop the batch.
		// Count attempts, not only successful deletes, toward the per-run step budget.
		for (const requestId of organizationRequestIds) {
			try {
				const result = (await ctx.runMutation(internal.data_deletion.process_organization_deletion_request, {
					requestId,
					_test_batchSize: args._test_batchSize,
				})) as process_organization_deletion_request_Result;
				madeProgress ||= result.deletedCount > 0 || result.done;
				shouldReschedule ||= !result.done;
			} catch (error) {
				hadFailure = true;
				shouldReschedule = true;
				console.error("Failed to process organization deletion request", {
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

		// If organization requests used the whole step budget, continue later before
		// moving on to lower-priority workspace requests.
		if (steps >= DELETION_MUTATION_STEPS_PER_ACTION) {
			shouldReschedule ||= organizationRequestIds.length > 0;
			break;
		}

		const workspaceRequestIds: Id<"data_deletion_requests">[] = await ctx.runQuery(
			internal.data_deletion.list_deletion_request_ids_by_scope,
			{ scope: "workspace", limit: WORKSPACE_DELETION_REQUEST_BATCH_SIZE, _test_now: test_now },
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

		// If workspace requests used the whole step budget, continue later. There
		// may be more workspace requests than this worker run was allowed to attempt.
		if (steps >= DELETION_MUTATION_STEPS_PER_ACTION) {
			shouldReschedule ||= workspaceRequestIds.length > 0;
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
