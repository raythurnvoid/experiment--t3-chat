import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import type { user_DataDeletionRequestScope } from "../server/users.ts";

const USER_DELETION_REQUEST_BATCH_SIZE = 25;

async function workspaces_queue_content_deletion_request(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		scope: user_DataDeletionRequestScope;
	},
) {
	const existing = await ctx.db
		.query("workspaces_data_deletion_requests")
		.withIndex("by_workspaceId_projectId", (q) => q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId))
		.first();

	if (existing) {
		return;
	}

	await ctx.db.insert("workspaces_data_deletion_requests", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		scope: args.scope,
	});
}

async function account_deletion_delete_orphaned_workspace(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
	},
) {
	const workspace = await ctx.db.get("workspaces", args.workspaceId);
	if (!workspace) {
		return;
	}

	const remainingMemberships = await ctx.db
		.query("workspaces_projects_users")
		.withIndex("by_workspaceId_projectId_userId", (q) => q.eq("workspaceId", args.workspaceId))
		.take(1);
	if (remainingMemberships.length > 0) {
		return;
	}

	const [projects, workspaceLimits] = await Promise.all([
		ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspaceId_default", (q) => q.eq("workspaceId", args.workspaceId))
			.collect(),
		ctx.db
			.query("limits_per_workspace")
			.withIndex("by_workspaceId_limitName", (q) => q.eq("workspaceId", args.workspaceId))
			.collect(),
	]);

	for (const project of projects) {
		await workspaces_queue_content_deletion_request(ctx, {
			workspaceId: args.workspaceId,
			projectId: project._id,
			scope: "user",
		});
	}

	await Promise.all(workspaceLimits.map((row) => ctx.db.delete("limits_per_workspace", row._id)));
	await Promise.all(projects.map((row) => ctx.db.delete("workspaces_projects", row._id)));
	await ctx.db.delete("workspaces", args.workspaceId);
}

export const enqueue_user_deletion_request = internalMutation({
	args: {
		clerkUserId: v.string(),
		userId: v.string(),
		nowTs: v.optional(v.number()),
	},
	returns: v.object({
		requestId: v.id("user_deletion_requests"),
		alreadyCompleted: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = args.nowTs ?? Date.now();
		const userId = ctx.db.normalizeId("users", args.userId);

		const existingRequests = await ctx.db
			.query("user_deletion_requests")
			.withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
			.collect();

		const activeRequest = existingRequests.find((row) => row.status === "queued" || row.status === "processing");
		if (activeRequest) {
			if (!activeRequest.userId && userId) {
				await ctx.db.patch("user_deletion_requests", activeRequest._id, {
					userId,
					updatedAt: now,
				});
			}

			return {
				requestId: activeRequest._id,
				alreadyCompleted: false,
			};
		}

		const completedRequest = existingRequests.find((row) => row.status === "completed");
		if (completedRequest) {
			return {
				requestId: completedRequest._id,
				alreadyCompleted: true,
			};
		}

		const failedRequest = existingRequests.find((row) => row.status === "failed");
		if (failedRequest) {
			await ctx.db.patch("user_deletion_requests", failedRequest._id, {
				status: "queued",
				userId: userId ?? failedRequest.userId,
				lastError: undefined,
				updatedAt: now,
			});

			return {
				requestId: failedRequest._id,
				alreadyCompleted: false,
			};
		}

		const requestId = await ctx.db.insert("user_deletion_requests", {
			clerkUserId: args.clerkUserId,
			userId: userId ?? undefined,
			status: "queued",
			attemptCount: 0,
			createdAt: now,
			updatedAt: now,
		});

		return {
			requestId,
			alreadyCompleted: false,
		};
	},
});

export const record_clerk_user_deleted_webhook = internalMutation({
	args: {
		eventId: v.string(),
		eventType: v.string(),
		clerkUserId: v.string(),
		receivedAt: v.number(),
	},
	returns: v.object({
		alreadyReceived: v.boolean(),
		requestQueued: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const existingReceipt = await ctx.db
			.query("clerk_webhook_receipts")
			.withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
			.first();
		if (existingReceipt) {
			return {
				alreadyReceived: true,
				requestQueued: false,
			};
		}

		const user = await ctx.db
			.query("users")
			.withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", args.clerkUserId))
			.first();

		await ctx.db.insert("clerk_webhook_receipts", {
			eventId: args.eventId,
			eventType: args.eventType,
			clerkUserId: args.clerkUserId,
			receivedAt: args.receivedAt,
		});

		const existingRequest = await ctx.db
			.query("user_deletion_requests")
			.withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
			.collect()
			.then((rows) =>
				rows.find((row) => row.status === "queued" || row.status === "processing" || row.status === "completed"),
			);
		if (existingRequest) {
			return {
				alreadyReceived: false,
				requestQueued: false,
			};
		}

		const failedRequest = await ctx.db
			.query("user_deletion_requests")
			.withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
			.collect()
			.then((rows) => rows.find((row) => row.status === "failed"));
		if (failedRequest) {
			await ctx.db.patch("user_deletion_requests", failedRequest._id, {
				status: "queued",
				userId: user?._id ?? failedRequest.userId,
				lastError: undefined,
				updatedAt: args.receivedAt,
			});

			return {
				alreadyReceived: false,
				requestQueued: true,
			};
		}

		return {
			alreadyReceived: false,
			requestQueued: false,
		};
	},
});

export const list_user_deletion_request_ids = internalQuery({
	args: {
		limit: v.number(),
	},
	returns: v.array(v.id("user_deletion_requests")),
	handler: async (ctx, args) => {
		const queued = await ctx.db
			.query("user_deletion_requests")
			.withIndex("by_status_updatedAt", (q) => q.eq("status", "queued"))
			.order("asc")
			.take(args.limit);

		const failed =
			queued.length >= args.limit
				? []
				: await ctx.db
						.query("user_deletion_requests")
						.withIndex("by_status_updatedAt", (q) => q.eq("status", "failed"))
						.order("asc")
						.take(args.limit - queued.length);

		return [...queued, ...failed].map((row) => row._id);
	},
});

export const process_user_deletion_request = internalMutation({
	args: {
		requestId: v.id("user_deletion_requests"),
		nowTs: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = args.nowTs ?? Date.now();
		const request = await ctx.db.get("user_deletion_requests", args.requestId);
		if (!request) {
			return null;
		}

		let user = request.userId ? await ctx.db.get("users", request.userId) : null;
		if (!user) {
			user = await ctx.db
				.query("users")
				.withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", request.clerkUserId))
				.first();
		}

		if (!user) {
			await ctx.db.patch("user_deletion_requests", request._id, {
				status: "completed",
				attemptCount: request.attemptCount + 1,
				lastError: undefined,
				lastAttemptAt: now,
				updatedAt: now,
			});

			return null;
		}

		const userIdString = String(user._id);
		const [memberships, anonymousAuthTokens, userLimits, pendingEdits, lastSequenceSaved] = await Promise.all([
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_userId_workspaceId_projectId", (q) => q.eq("userId", user._id))
				.collect(),
			ctx.db
				.query("users_anon_tokens")
				.withIndex("by_userId", (q) => q.eq("userId", user._id))
				.collect(),
			ctx.db
				.query("limits_per_user")
				.withIndex("by_userId", (q) => q.eq("userId", user._id))
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
		for (const membership of memberships) {
			affectedWorkspaceIds.add(membership.workspaceId);
		}

		await Promise.all(
			pendingEditCleanupTasks.map((row) => ctx.db.delete("pages_pending_edits_cleanup_tasks", row._id)),
		);
		await Promise.all(
			lastSequenceSaved.map((row) => ctx.db.delete("pages_pending_edits_last_sequence_saved", row._id)),
		);
		await Promise.all(pendingEdits.map((row) => ctx.db.delete("pages_pending_edits", row._id)));
		await Promise.all(memberships.map((row) => ctx.db.delete("workspaces_projects_users", row._id)));
		await Promise.all(anonymousAuthTokens.map((row) => ctx.db.delete("users_anon_tokens", row._id)));
		await Promise.all(userLimits.map((row) => ctx.db.delete("limits_per_user", row._id)));

		await ctx.db.patch("users", user._id, {
			clerkUserId: null,
			anonymousAuthToken: undefined,
			defaultWorkspaceId: undefined,
			defaultProjectId: undefined,
			deletedAt: user.deletedAt ?? now,
		});

		for (const workspaceId of affectedWorkspaceIds) {
			await account_deletion_delete_orphaned_workspace(ctx, {
				workspaceId,
			});
		}

		await ctx.db.patch("user_deletion_requests", request._id, {
			userId: user._id,
			status: "completed",
			attemptCount: request.attemptCount + 1,
			lastError: undefined,
			lastAttemptAt: now,
			updatedAt: now,
		});

		return null;
	},
});

export const mark_user_deletion_request_failed = internalMutation({
	args: {
		requestId: v.id("user_deletion_requests"),
		errorMessage: v.string(),
		nowTs: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const request = await ctx.db.get("user_deletion_requests", args.requestId);
		if (!request) {
			return null;
		}

		const now = args.nowTs ?? Date.now();
		await ctx.db.patch("user_deletion_requests", request._id, {
			status: request.status === "completed" ? "completed" : "failed",
			attemptCount: request.attemptCount + 1,
			lastError: args.errorMessage,
			lastAttemptAt: now,
			updatedAt: now,
		});

		return null;
	},
});

export const process_user_deletion_requests = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const requestIds: Id<"user_deletion_requests">[] = await ctx.runQuery(
			internal.account_deletion.list_user_deletion_request_ids,
			{ limit: USER_DELETION_REQUEST_BATCH_SIZE },
		);

		for (const requestId of requestIds) {
			try {
				await ctx.runMutation(internal.account_deletion.process_user_deletion_request, {
					requestId,
					nowTs: now,
				});
			} catch (error) {
				console.error("[account_deletion.process_user_deletion_requests] Failed to process request", {
					error,
					requestId,
				});
			}
		}
	},
});
