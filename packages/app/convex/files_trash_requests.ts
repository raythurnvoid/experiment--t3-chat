// Trash requests are approvals, not file drafts. The queue runs the existing Trash jobs after review.

import { Result } from "common/errors-as-values-utils.ts";
import { doc } from "convex-helpers/validators";
import { paginationOptsValidator, paginationResultValidator, type PaginationOptions } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation, mutation } from "./functions.ts";
import app_convex_schema, { ai_chat_workspaces_source_validator } from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { files_DRAFT_IDLE_EXPIRY_MS } from "../server/files.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import {
	files_archive_runs_REQUEST_MAX_CHECK_NODES,
	files_archive_runs_REQUEST_MAX_NODES,
} from "../server/files-archive-runs.ts";
import { files_archive_operation_id_cutoff } from "../shared/files.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_get,
} from "./organizations_membership_lifetimes.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { activities_db_get_by_source_id, activities_is_active } from "./activities_db.ts";
import { files_nodes_db_get_tree_reader_for_user } from "./files_tree_db.ts";
import { files_trash_agent_db_check_area, files_trash_agent_db_get_reader } from "./files_trash_agent.ts";
import {
	files_archive_runs_db_request_stop,
	files_archive_runs_db_start,
	files_archive_runs_db_start_purge,
} from "./files_archive_runs.ts";
import { files_pending_update_runs_db_seal } from "./files_pending_update_runs.ts";
import { files_subtree_ops_db_check_live_limit } from "./files_subtree_ops_db.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";

const PAGE_SIZE = 100;
const RECOVER_AFTER_MS = 5 * 60 * 1000;
const GUEST_MESSAGE =
	"Permission denied. Guests have no Trash view. A workspace member can do this, or ask for workspace access.";

const agent_args = {
	membershipId: v.id("organizations_workspaces_users"),
	userId: v.id("users"),
	agentSource: ai_chat_workspaces_source_validator,
};
const request_fields = doc(app_convex_schema, "files_trash_requests").fields;
const list_item_validator = v.object({
	requestId: v.id("files_trash_requests"),
	kind: request_fields.kind,
	status: request_fields.status,
	updatedAt: v.number(),
});
const view_validator = v.object({
	requestId: v.id("files_trash_requests"),
	kind: request_fields.kind,
	status: request_fields.status,
	path: v.union(v.string(), v.null()),
	locked: v.boolean(),
	outcome: request_fields.outcome,
	archiveRunId: request_fields.archiveRunId,
	activityId: request_fields.activityId,
	canAccept: v.boolean(),
	canDiscard: v.boolean(),
	canStop: v.boolean(),
	canDismiss: v.boolean(),
});

async function db_get_public_membership(ctx: QueryCtx, membershipId: Id<"organizations_workspaces_users">) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
	const membership = await organizations_db_get_membership(ctx, { userId: userAuth.id, membershipId });
	return membership ? Result({ _yay: membership }) : Result({ _nay: { message: "Unauthorized" } });
}

async function db_get_owned_request(
	ctx: QueryCtx,
	args: { membership: Doc<"organizations_workspaces_users">; requestId: string },
) {
	const requestId = ctx.db.normalizeId("files_trash_requests", args.requestId);
	const request = requestId ? await ctx.db.get("files_trash_requests", requestId) : null;
	return request &&
		request.organizationId === args.membership.organizationId &&
		request.workspaceId === args.membership.workspaceId &&
		request.userId === args.membership.userId
		? request
		: null;
}

async function db_get_batch_membership(ctx: QueryCtx, batch: Doc<"files_trash_request_batches">) {
	const [user, workspace, lifetime] = await Promise.all([
		ctx.db.get("users", batch.userId),
		ctx.db.get("organizations_workspaces", batch.workspaceId),
		organizations_membership_lifetimes_db_get(ctx, batch),
	]);
	if (
		!user ||
		user.deletedAt !== undefined ||
		!workspace ||
		workspace.organizationId !== batch.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		!lifetime?.active ||
		lifetime.membershipId !== batch.membershipId ||
		lifetime.lifetime !== batch.membershipLifetime
	)
		return null;
	return await organizations_db_get_membership(ctx, { userId: batch.userId, membershipId: batch.membershipId });
}

async function db_change_summaries(
	ctx: MutationCtx,
	request: Pick<Doc<"files_trash_requests">, "organizationId" | "workspaceId" | "userId" | "threadId">,
	change: 1 | -1,
) {
	for (const listKey of ["all", request.threadId]) {
		const summary = await ctx.db
			.query("files_trash_request_summaries")
			.withIndex("by_org_ws_user_listKey", (q) =>
				q
					.eq("organizationId", request.organizationId)
					.eq("workspaceId", request.workspaceId)
					.eq("userId", request.userId)
					.eq("listKey", listKey),
			)
			.first();
		const count = (summary?.count ?? 0) + change;
		if (count <= 0) {
			if (summary) await ctx.db.delete("files_trash_request_summaries", summary._id);
			continue;
		}
		const latest =
			listKey === "all"
				? await ctx.db
						.query("files_trash_requests")
						.withIndex("by_org_ws_user", (q) =>
							q
								.eq("organizationId", request.organizationId)
								.eq("workspaceId", request.workspaceId)
								.eq("userId", request.userId),
						)
						.order("desc")
						.first()
				: await ctx.db
						.query("files_trash_requests")
						.withIndex("by_org_ws_user_thread", (q) =>
							q
								.eq("organizationId", request.organizationId)
								.eq("workspaceId", request.workspaceId)
								.eq("userId", request.userId)
								.eq("threadId", request.threadId),
						)
						.order("desc")
						.first();
		const fields = { count, lastUpdatedAt: latest?._creationTime ?? Date.now() };
		if (summary) await ctx.db.patch("files_trash_request_summaries", summary._id, fields);
		else
			await ctx.db.insert("files_trash_request_summaries", {
				organizationId: request.organizationId,
				workspaceId: request.workspaceId,
				userId: request.userId,
				listKey,
				isSource: listKey !== "all",
				...fields,
			});
	}
}

async function db_delete_request(ctx: MutationCtx, request: Doc<"files_trash_requests">) {
	await ctx.db.delete("files_trash_requests", request._id);
	await db_change_summaries(ctx, request, -1);
}

async function db_finish_request(
	ctx: MutationCtx,
	request: Doc<"files_trash_requests">,
	outcome: NonNullable<Doc<"files_trash_requests">["outcome"]>,
) {
	const now = Date.now();
	await ctx.db.patch("files_trash_requests", request._id, {
		status: "finished",
		outcome,
		updatedAt: now,
		expiresAt: now + files_DRAFT_IDLE_EXPIRY_MS,
	});

	if (request.batchId) {
		const batch = await ctx.db.get("files_trash_request_batches", request.batchId);
		if (batch?.active) {
			await ctx.db.patch("files_trash_request_batches", batch._id, {
				...(batch.currentRequestId === request._id && { currentRequestId: null }),
				updatedAt: now,
				...(request.kind === "restore" &&
					outcome.status !== "succeeded" && {
						destructiveBlockedReason: "A restore did not finish. Check its result, then ask for deletion again.",
					}),
			});
			await ctx.scheduler.runAfter(0, internal.files_trash_requests.advance, { batchId: batch._id });
		}
	}
}

export async function files_trash_requests_db_get_summary(args: {
	ctx: QueryCtx;
	membership: Doc<"organizations_workspaces_users">;
	listKey: string;
}) {
	const { ctx, membership } = args;
	const summary = await ctx.db
		.query("files_trash_request_summaries")
		.withIndex("by_org_ws_user_listKey", (q) =>
			q
				.eq("organizationId", membership.organizationId)
				.eq("workspaceId", membership.workspaceId)
				.eq("userId", membership.userId)
				.eq("listKey", args.listKey),
		)
		.first();
	return { count: summary?.count ?? 0 };
}

async function db_list(
	ctx: QueryCtx,
	args: { membership: Doc<"organizations_workspaces_users">; listKey: string; paginationOpts: PaginationOptions },
) {
	const { membership } = args;
	const threadId = ctx.db.normalizeId("ai_chat_threads", args.listKey);
	if (args.listKey !== "all" && threadId === null) return { page: [], isDone: true, continueCursor: "" };
	const range =
		args.listKey === "all"
			? ctx.db
					.query("files_trash_requests")
					.withIndex("by_org_ws_user", (q) =>
						q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("userId", membership.userId),
					)
			: ctx.db
					.query("files_trash_requests")
					.withIndex("by_org_ws_user_thread", (q) =>
						q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("userId", membership.userId)
							.eq("threadId", threadId!),
					);
	const result = await range
		.order("desc")
		.paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 50) });
	return {
		...result,
		page: result.page.map((request) => ({
			requestId: request._id,
			kind: request.kind,
			status: request.status,
			updatedAt: request.updatedAt,
		})),
	};
}

async function db_get_view(
	ctx: QueryCtx,
	request: Doc<"files_trash_requests">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const reader = await files_nodes_db_get_tree_reader_for_user(ctx, {
		userAuth: { id: membership.userId },
		membershipId: membership._id,
	});
	const nodeId = request.source.kind === "node" ? request.source.nodeId : request.source.area;
	const node = nodeId ? await files_saved_placement_db_get_node(ctx.db, nodeId) : null;
	const inWorkspace = node?.organizationId === membership.organizationId && node.workspaceId === membership.workspaceId;
	const readable =
		!!reader?.hasWorkspaceRead &&
		(nodeId === null || (!!node && inWorkspace && (await reader.checker.can(node, "content.read"))));
	const locked = !reader?.hasWorkspaceRead || (!!node && !readable);
	const batch = request.batchId ? await ctx.db.get("files_trash_request_batches", request.batchId) : null;
	const lifetime = await organizations_membership_lifetimes_db_get(ctx, membership);
	let canAccept =
		request.status === "waiting" &&
		!!reader?.hasWorkspaceRead &&
		!locked &&
		lifetime?.lifetime === request.membershipLifetime &&
		lifetime.membershipId === request.membershipId;
	if (canAccept && (nodeId === null || node)) {
		canAccept = !(
			await access_control_db_authorize_membership(ctx, {
				userAuth: { id: membership.userId },
				membership,
				permission: request.kind === "restore" ? "content.write" : "content.permissions.manage",
				...(node && { fileNode: node }),
			})
		)._nay;
	}
	return {
		requestId: request._id,
		kind: request.kind,
		status: request.status,
		path: readable ? request.originalPath : null,
		locked,
		outcome:
			locked && request.outcome
				? { status: request.outcome.status, message: "Permission denied. Ask for access to see this result." }
				: request.outcome,
		archiveRunId: request.archiveRunId,
		activityId: request.activityId,
		canAccept,
		canDiscard: request.status === "waiting" || request.status === "queued",
		canStop: request.status === "running" && request.archiveRunId !== null,
		canDismiss: request.status === "finished" && !batch?.active,
	};
}

export const list_requests = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		listKey: v.string(),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(list_item_validator),
	handler: async (ctx, args) => {
		const membership = await db_get_public_membership(ctx, args.membershipId);
		if (membership._nay) {
			if (membership._nay.message === "Unauthenticated") throw convex_error(membership._nay);
			return { page: [], isDone: true, continueCursor: "" };
		}
		return await db_list(ctx, { ...args, membership: membership._yay });
	},
});

export const get_request = query({
	args: { membershipId: v.id("organizations_workspaces_users"), requestId: v.id("files_trash_requests") },
	returns: v.union(view_validator, v.null()),
	handler: async (ctx, args) => {
		const membership = await db_get_public_membership(ctx, args.membershipId);
		if (membership._nay) {
			if (membership._nay.message === "Unauthenticated") throw convex_error(membership._nay);
			return null;
		}
		const request = await db_get_owned_request(ctx, { ...args, membership: membership._yay });
		return request ? await db_get_view(ctx, request, membership._yay) : null;
	},
});

export const list_sources = query({
	args: { membershipId: v.id("organizations_workspaces_users"), paginationOpts: paginationOptsValidator },
	returns: paginationResultValidator(
		v.object({
			listKey: v.string(),
			lastUpdatedAt: v.number(),
			keyCreationTime: v.number(),
			keyId: v.id("files_trash_request_summaries"),
		}),
	),
	handler: async (ctx, args) => {
		const authorized = await db_get_public_membership(ctx, args.membershipId);
		if (authorized._nay) {
			if (authorized._nay.message === "Unauthenticated") throw convex_error(authorized._nay);
			return { page: [], isDone: true, continueCursor: "" };
		}
		const membership = authorized._yay;
		const result = await ctx.db
			.query("files_trash_request_summaries")
			.withIndex("by_org_ws_user_isSource_lastUpdatedAt", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", membership.userId)
					.eq("isSource", true),
			)
			.order("desc")
			.paginate(args.paginationOpts);
		return {
			...result,
			page: result.page.map((summary) => ({
				listKey: summary.listKey,
				lastUpdatedAt: summary.lastUpdatedAt,
				keyCreationTime: summary._creationTime,
				keyId: summary._id,
			})),
		};
	},
});

export const list_for_agent = internalQuery({
	args: { ...agent_args, paginationOpts: paginationOptsValidator },
	returns: v_result({ _yay: paginationResultValidator(list_item_validator) }),
	handler: async (ctx, args) => {
		const reader = await files_trash_agent_db_get_reader(ctx, args);
		if (reader._nay) return reader;
		return Result({
			_yay: await db_list(ctx, {
				membership: reader._yay.membership,
				listKey: "all",
				paginationOpts: args.paginationOpts,
			}),
		});
	},
});

export const get_for_agent = internalQuery({
	args: { ...agent_args, requestId: v.string() },
	returns: v_result({ _yay: v.union(view_validator, v.null()) }),
	handler: async (ctx, args) => {
		const reader = await files_trash_agent_db_get_reader(ctx, args);
		if (reader._nay) return reader;
		const request = await db_get_owned_request(ctx, { ...args, membership: reader._yay.membership });
		return Result({ _yay: request ? await db_get_view(ctx, request, reader._yay.membership) : null });
	},
});

export const propose = internalMutation({
	args: {
		...agent_args,
		request: v.union(
			v.object({
				kind: v.union(v.literal("restore"), v.literal("purge")),
				nodeId: v.string(),
				archiveOperationId: v.string(),
			}),
			v.object({ kind: v.literal("empty"), area: v.union(v.id("files_nodes"), v.null()) }),
		),
	},
	returns: v_result({
		_yay: v.object({ requestId: v.id("files_trash_requests"), kind: request_fields.kind, path: v.string() }),
	}),
	handler: async (ctx, args) => {
		const authorized = await files_trash_agent_db_get_reader(ctx, args);
		if (authorized._nay) return authorized;
		const reader = authorized._yay;
		const membership = reader.membership;
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: args.userId });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });

		let source: Doc<"files_trash_requests">["source"];
		let path: string;
		let node: Doc<"files_nodes"> | null;
		if (args.request.kind === "empty") {
			const checked = await files_trash_agent_db_check_area(ctx, { reader, area: args.request.area });
			if (checked._nay) return checked;
			node = args.request.area ? await files_saved_placement_db_get_node(ctx.db, args.request.area) : null;
			source = { kind: "area", area: args.request.area };
			path = node?.path ?? "/";
		} else {
			const nodeId = ctx.db.normalizeId("files_nodes", args.request.nodeId);
			node = nodeId ? await files_saved_placement_db_get_node(ctx.db, nodeId) : null;
			if (!node || node.organizationId !== membership.organizationId || node.workspaceId !== membership.workspaceId)
				return Result({ _nay: { message: "No Trash item" } });
			if (!(await reader.checker.can(node, "content.read"))) return Result({ _nay: { message: "Permission denied" } });
			if (node.archiveOperationId === null || node.archiveOperationId !== args.request.archiveOperationId)
				return Result({ _nay: { message: "This Trash item changed. Run trash ls and pick it again." } });
			source = { kind: "node", nodeId: node._id, archiveOperationId: args.request.archiveOperationId };
			path = node.archivedPath ?? node.path;
		}

		const writable = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership,
			permission: args.request.kind === "restore" ? "content.write" : "content.permissions.manage",
			...(node && { fileNode: node }),
		});
		if (writable._nay) return writable;

		const now = Date.now();
		const fields = {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: args.userId,
			membershipId: membership._id,
			membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, membership),
			threadId: args.agentSource.threadId,
			kind: args.request.kind,
			source,
			originalPath: path,
			status: "waiting" as const,
			batchId: null,
			batchOrder: null,
			archiveRunId: null,
			activityId: null,
			outcome: null,
			updatedAt: now,
			expiresAt: now + files_DRAFT_IDLE_EXPIRY_MS,
		};
		const requestId = await ctx.db.insert("files_trash_requests", fields);
		await db_change_summaries(ctx, fields, 1);

		return Result({ _yay: { requestId, kind: args.request.kind, path } });
	},
});

async function db_cancel(ctx: MutationCtx, request: Doc<"files_trash_requests">) {
	if (request.status === "running")
		return Result({ _nay: { message: "This request is running. Use Stop on its Pending row." } });
	const batch = request.batchId ? await ctx.db.get("files_trash_request_batches", request.batchId) : null;
	if (request.status === "finished" && batch?.active)
		return Result({ _nay: { message: "Wait for this review to finish before dismissing its result." } });
	if (batch?.active) {
		await db_finish_request(ctx, request, { status: "canceled", message: "Request canceled. No files were changed." });
	} else await db_delete_request(ctx, request);
	return Result({ _yay: null });
}

export const cancel_for_agent = internalMutation({
	args: { ...agent_args, requestId: v.string() },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const reader = await files_trash_agent_db_get_reader(ctx, args);
		if (reader._nay) return reader;
		const request = await db_get_owned_request(ctx, { ...args, membership: reader._yay.membership });
		return request ? await db_cancel(ctx, request) : Result({ _nay: { message: "Not found" } });
	},
});

export const discard = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), requestId: v.id("files_trash_requests") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const membership = await db_get_public_membership(ctx, args.membershipId);
		if (membership._nay) return membership;
		const request = await db_get_owned_request(ctx, { ...args, membership: membership._yay });
		return request ? await db_cancel(ctx, request) : Result({ _nay: { message: "Not found" } });
	},
});

export const dismiss = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), requestId: v.id("files_trash_requests") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const membership = await db_get_public_membership(ctx, args.membershipId);
		if (membership._nay) return membership;
		const request = await db_get_owned_request(ctx, { ...args, membership: membership._yay });
		if (!request) return Result({ _nay: { message: "Not found" } });
		if (request.status !== "finished") return Result({ _nay: { message: "This request has not finished." } });
		return await db_cancel(ctx, request);
	},
});

export const stop = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), requestId: v.id("files_trash_requests") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const membership = await db_get_public_membership(ctx, args.membershipId);
		if (membership._nay) return membership;
		const request = await db_get_owned_request(ctx, { ...args, membership: membership._yay });
		if (!request) return Result({ _nay: { message: "Not found" } });
		if (request.status === "running" && request.archiveRunId) {
			await files_archive_runs_db_request_stop(ctx, { runId: request.archiveRunId, reason: "user", now: Date.now() });
			if (request.batchId)
				await ctx.scheduler.runAfter(0, internal.files_trash_requests.advance, { batchId: request.batchId });
		}
		return Result({ _yay: null });
	},
});

async function db_get_owned_batch(
	ctx: QueryCtx,
	membership: Doc<"organizations_workspaces_users">,
	batchId: Id<"files_trash_request_batches">,
) {
	const batch = await ctx.db.get("files_trash_request_batches", batchId);
	return batch &&
		batch.organizationId === membership.organizationId &&
		batch.workspaceId === membership.workspaceId &&
		batch.userId === membership.userId
		? batch
		: null;
}

async function db_validate_page(
	ctx: QueryCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		membershipLifetime: number;
		kind: "accept" | "discard";
		requestIds: Id<"files_trash_requests">[];
	},
) {
	if (args.requestIds.length > PAGE_SIZE || new Set(args.requestIds).size !== args.requestIds.length)
		return Result({ _nay: { message: "Send each request once, in pages of at most 100." } });
	const requests: Doc<"files_trash_requests">[] = [];
	for (const requestId of args.requestIds) {
		const request = await db_get_owned_request(ctx, { membership: args.membership, requestId });
		if (
			!request ||
			(args.kind === "accept"
				? request.status !== "waiting"
				: request.status !== "waiting" && request.status !== "finished")
		)
			return Result({ _nay: { message: "This selection changed. Refresh Pending and select it again." } });
		if (request.batchId && (await ctx.db.get("files_trash_request_batches", request.batchId))?.active)
			return Result({ _nay: { message: "A selected request is already being reviewed." } });
		if (
			args.kind === "accept" &&
			(request.membershipId !== args.membership._id || request.membershipLifetime !== args.membershipLifetime)
		)
			return Result({ _nay: { message: "Workspace access changed. Discard this request and ask the agent again." } });
		requests.push(request);
	}
	return Result({ _yay: requests });
}

export const start = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		requestId: v.string(),
		kind: v.union(v.literal("accept"), v.literal("discard")),
		expectedItemCount: v.number(),
		requestIds: v.array(v.id("files_trash_requests")),
		afterReviewRunId: v.union(v.id("files_pending_update_runs"), v.null()),
	},
	returns: v_result({ _yay: v.object({ batchId: v.id("files_trash_request_batches") }) }),
	handler: async (ctx, args) => {
		const authorized = await db_get_public_membership(ctx, args.membershipId);
		if (authorized._nay) return authorized;
		const membership = authorized._yay;

		if (
			!args.requestId ||
			args.requestId.length > 200 ||
			!Number.isSafeInteger(args.expectedItemCount) ||
			args.expectedItemCount < 1 ||
			args.expectedItemCount < args.requestIds.length
		)
			return Result({ _nay: { message: "Select a valid number of requests." } });

		const requestHash = await crypto_sha256_hex(
			JSON.stringify([args.membershipId, args.kind, args.expectedItemCount, args.requestIds, args.afterReviewRunId]),
		);
		const existing = await ctx.db
			.query("files_trash_request_batches")
			.withIndex("by_user_requestId", (q) => q.eq("userId", membership.userId).eq("requestId", args.requestId))
			.first();
		if (existing) {
			if (existing.requestHash !== requestHash || !(await db_get_batch_membership(ctx, existing)))
				return Result({ _nay: { message: "This request ID was already used for another selection." } });
			if (existing.stopping && existing.approvedAt === undefined)
				return Result({ _nay: { message: "This review did not start. Select the requests again." } });
			return Result({ _yay: { batchId: existing._id } });
		}

		const active = await ctx.db
			.query("files_trash_request_batches")
			.withIndex("by_org_ws_user_active", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", membership.userId)
					.eq("active", true),
			)
			.first();
		if (active) return Result({ _nay: { message: "A Trash review is already running in this workspace." } });

		const reader = await files_nodes_db_get_tree_reader_for_user(ctx, {
			userAuth: { id: membership.userId },
			membershipId: membership._id,
		});
		if (!reader?.hasWorkspaceRead) return Result({ _nay: { message: GUEST_MESSAGE } });
		const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
		if (args.afterReviewRunId) {
			const review = await ctx.db.get("files_pending_update_runs", args.afterReviewRunId);
			const activity = await activities_db_get_by_source_id(ctx, args.afterReviewRunId);
			if (
				!review ||
				review.organizationId !== membership.organizationId ||
				review.workspaceId !== membership.workspaceId ||
				review.userId !== membership.userId ||
				review.kind !== args.kind ||
				review.step !== "uploading" ||
				activity?.membershipId !== membership._id ||
				activity.membershipLifetime !== membershipLifetime
			)
				return Result({ _nay: { message: "Start a new review for this selection." } });
		}

		const checked = await db_validate_page(ctx, { ...args, membership, membershipLifetime });
		if (checked._nay) return checked;

		const now = Date.now();
		const batchId = await ctx.db.insert("files_trash_request_batches", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			membershipId: membership._id,
			membershipLifetime,
			requestId: args.requestId,
			requestHash,
			kind: args.kind,
			step: "uploading",
			active: true,
			expectedItemCount: args.expectedItemCount,
			itemCount: args.requestIds.length,
			afterReviewRunId: args.afterReviewRunId,
			hasEmpty: checked._yay.some((request) => request.kind === "empty"),
			phase: "restore",
			currentRequestId: null,
			destructiveBlockedReason: null,
			stopping: false,
			errorMessage: null,
			updatedAt: now,
		});
		for (const [batchOrder, request] of checked._yay.entries())
			await ctx.db.patch("files_trash_requests", request._id, {
				batchId,
				batchOrder,
				status: request.status === "finished" ? "finished" : "queued",
				updatedAt: now,
			});

		return Result({ _yay: { batchId } });
	},
});

export const append_items = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		batchId: v.id("files_trash_request_batches"),
		offset: v.number(),
		requestIds: v.array(v.id("files_trash_requests")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const membership = await db_get_public_membership(ctx, args.membershipId);
		if (membership._nay) return membership;
		const batch = await db_get_owned_batch(ctx, membership._yay, args.batchId);
		if (!batch || !(await db_get_batch_membership(ctx, batch))) return Result({ _nay: { message: "Not found" } });
		if (
			!Number.isSafeInteger(args.offset) ||
			args.offset < 0 ||
			!args.requestIds.length ||
			args.requestIds.length > PAGE_SIZE
		)
			return Result({ _nay: { message: "Send a valid page of requests." } });

		if (args.offset < batch.itemCount) {
			for (const [index, requestId] of args.requestIds.entries()) {
				const stored = await ctx.db
					.query("files_trash_requests")
					.withIndex("by_batch_order", (q) => q.eq("batchId", batch._id).eq("batchOrder", args.offset + index))
					.first();
				if (stored?._id !== requestId)
					return Result({ _nay: { message: "This page does not match the saved selection." } });
			}
			return Result({ _yay: null });
		}
		if (
			batch.step !== "uploading" ||
			args.offset !== batch.itemCount ||
			args.offset + args.requestIds.length > batch.expectedItemCount
		)
			return Result({ _nay: { message: "This selection changed. Start a new review." } });

		const checked = await db_validate_page(ctx, {
			...args,
			membership: membership._yay,
			membershipLifetime: batch.membershipLifetime,
			kind: batch.kind,
		});
		if (checked._nay) return checked;

		const now = Date.now();
		for (const [index, request] of checked._yay.entries())
			await ctx.db.patch("files_trash_requests", request._id, {
				batchId: batch._id,
				batchOrder: args.offset + index,
				status: request.status === "finished" ? "finished" : "queued",
				updatedAt: now,
			});
		await ctx.db.patch("files_trash_request_batches", batch._id, {
			itemCount: batch.itemCount + args.requestIds.length,
			hasEmpty: batch.hasEmpty || checked._yay.some((request) => request.kind === "empty"),
			updatedAt: now,
		});
		return Result({ _yay: null });
	},
});

export const seal = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), batchId: v.id("files_trash_request_batches") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const membership = await db_get_public_membership(ctx, args.membershipId);
		if (membership._nay) return membership;
		const batch = await db_get_owned_batch(ctx, membership._yay, args.batchId);
		if (!batch || !(await db_get_batch_membership(ctx, batch))) return Result({ _nay: { message: "Not found" } });
		if (batch.stopping && batch.approvedAt === undefined)
			return Result({ _nay: { message: "This review did not start. Select the requests again." } });
		if (batch.step !== "uploading") return Result({ _yay: null });
		if (batch.itemCount !== batch.expectedItemCount || batch.stopping)
			return Result({ _nay: { message: "Send all selected requests before starting." } });

		// Seal both selections together. Nothing fallible follows the ordinary review's writes.
		if (batch.afterReviewRunId) {
			const sealed = await files_pending_update_runs_db_seal(ctx, {
				membershipId: args.membershipId,
				runId: batch.afterReviewRunId,
			});
			if (sealed._nay) return sealed;
		}
		await ctx.db.patch("files_trash_request_batches", batch._id, {
			step: "running",
			approvedAt: Date.now(),
			updatedAt: Date.now(),
		});
		await ctx.scheduler.runAfter(0, internal.files_trash_requests.advance, { batchId: batch._id });
		return Result({ _yay: null });
	},
});

/**
 * Copy the final job result before history can remove its Activity. Repair must have finished.
 */
export async function files_trash_requests_db_settle_child(ctx: MutationCtx, run: Doc<"files_archive_runs">) {
	if (!run.trashRequestId || run.active) return;
	const request = await ctx.db.get("files_trash_requests", run.trashRequestId);
	if (!request || request.status === "finished") return;
	const activity = await activities_db_get_by_source_id(ctx, run._id);
	if (!activity || activities_is_active(activity.status)) return;

	const batch = request.batchId ? await ctx.db.get("files_trash_request_batches", request.batchId) : null;
	await ctx.db.patch("files_trash_requests", request._id, { archiveRunId: run._id, activityId: activity._id });

	// A queued restore can find its source gone after an earlier purge finishes.
	const restoredNothing =
		request.kind === "restore" && activity.status === "succeeded" && !activity.progress?.completed;
	const status =
		restoredNothing || (activity.errorCode === "name_conflict" && !activity.progress?.completed)
			? "noop"
			: activity.status === "succeeded"
				? "succeeded"
				: (activity.progress?.completed ?? 0) > 0
					? "partial"
					: activity.status === "canceled" || activity.status === "timed_out"
						? activity.status
						: "failed";
	await db_finish_request(ctx, request, {
		status,
		message:
			(restoredNothing
				? "The original Trash item was not restored. No files were changed."
				: batch?.stopping && status !== "succeeded"
					? "Workspace access changed. Completed changes were kept."
					: activity.errorMessage) ??
			(status === "succeeded"
				? "Finished."
				: status === "partial"
					? "The job stopped after changing some items. Those changes were kept."
					: "The job stopped. Check its result before trying again."),
	});
}

async function db_start_request(
	ctx: MutationCtx,
	batch: Doc<"files_trash_request_batches">,
	request: Doc<"files_trash_requests">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const reader = await files_nodes_db_get_tree_reader_for_user(ctx, {
		userAuth: { id: batch.userId },
		membershipId: membership._id,
	});
	if (!reader?.hasWorkspaceRead)
		return await db_finish_request(ctx, request, { status: "blocked", message: GUEST_MESSAGE });

	let node: Doc<"files_nodes"> | null = null;
	if (request.source.kind === "node") {
		node = await files_saved_placement_db_get_node(ctx.db, request.source.nodeId);
		if (!node || node.organizationId !== batch.organizationId || node.workspaceId !== batch.workspaceId)
			return await db_finish_request(ctx, request, {
				status: "noop",
				message: "The original Trash item is gone. No files were changed.",
			});
		if (!(await reader.checker.can(node, "content.read")))
			return await db_finish_request(ctx, request, {
				status: "blocked",
				message: "Permission denied. Ask for access, then make a new request.",
			});

		const busy = await ctx.db
			.query("files_archive_runs")
			.withIndex("by_organization_workspace_archiveOperation_active", (q) =>
				q
					.eq("organizationId", batch.organizationId)
					.eq("workspaceId", batch.workspaceId)
					.eq("archiveOperationId", request.source.kind === "node" ? request.source.archiveOperationId : "")
					.eq("active", true),
			)
			.first();
		if (busy)
			return await db_finish_request(ctx, request, {
				status: "blocked",
				message: "This delete still has a running job. Wait for it to finish, then make a new request.",
			});
		if (node.archiveOperationId !== request.source.archiveOperationId)
			return await db_finish_request(ctx, request, {
				status: "noop",
				message: "The item is live or belongs to a newer delete. No files were changed.",
			});
	} else {
		const area = await files_trash_agent_db_check_area(ctx, { reader, area: request.source.area });
		if (area._nay) return await db_finish_request(ctx, request, { status: "blocked", message: area._nay.message });
		node = request.source.area ? await files_saved_placement_db_get_node(ctx.db, request.source.area) : null;
		const busy = await ctx.db
			.query("files_archive_runs")
			.withIndex("by_org_ws_active_emptyArchive_cutoff", (q) =>
				q
					.eq("organizationId", batch.organizationId)
					.eq("workspaceId", batch.workspaceId)
					.eq("active", true)
					.gte("emptyArchive.cutoff", ""),
			)
			.first();
		if (busy)
			return await db_finish_request(ctx, request, {
				status: "blocked",
				message: "Empty Trash is already running. Wait for it, then make a new request.",
			});
	}

	const access = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: batch.userId },
		membership,
		permission: request.kind === "restore" ? "content.write" : "content.permissions.manage",
		...(node && { fileNode: node }),
	});
	if (access._nay) return await db_finish_request(ctx, request, { status: "blocked", message: access._nay.message });
	// A purge checks this limit when it starts.
	if (request.kind === "restore") {
		const liveLimit = await files_subtree_ops_db_check_live_limit(ctx, {
			organizationId: batch.organizationId,
			workspaceId: batch.workspaceId,
			count: 1,
		});
		if (liveLimit) return await db_finish_request(ctx, request, { status: "blocked", message: liveLimit.message });
	}

	// These links and the child's first writes commit together, so a retry cannot start it twice.
	await ctx.db.patch("files_trash_requests", request._id, { status: "running", updatedAt: Date.now() });
	await ctx.db.patch("files_trash_request_batches", batch._id, {
		currentRequestId: request._id,
		updatedAt: Date.now(),
	});

	let runId: Id<"files_archive_runs"> | null = null;
	let refusal: string | null = null;
	if (request.kind === "restore" && request.source.kind === "node" && node) {
		const started = await files_archive_runs_db_start(ctx, {
			kind: "restore",
			userAuth: { id: batch.userId },
			membership,
			credentialId: null,
			trashRequestId: request._id,
			archiveOperationId: request.source.archiveOperationId,
			rootNodeIds: [],
			restoreRoots: [{ nodeId: node._id, treePath: node.treePath }],
			refusedNodes: [],
			isFast: false,
			treePaths: [node.treePath],
			budget: {
				nodes: files_archive_runs_REQUEST_MAX_NODES,
				checkNodes: files_archive_runs_REQUEST_MAX_CHECK_NODES,
				hasPaginated: false,
			},
			previousRunId: null,
			applyToRemaining: { file: null, folder: null },
		});
		runId = started._yay?.runId ?? started._nay?.data?.runId ?? null;
		refusal = started._nay?.message ?? null;
	} else {
		const started = await files_archive_runs_db_start_purge(ctx, {
			userAuth: { id: batch.userId },
			membership,
			trashRequestId: request._id,
			nodes: request.source.kind === "node" && node ? [node] : [],
			emptyArchive:
				request.source.kind === "area"
					? { area: request.source.area, cutoff: files_archive_operation_id_cutoff(batch.approvedAt!) }
					: null,
		});
		runId = started._yay?.runId ?? null;
		refusal = started._nay?.message ?? null;
	}

	if (!runId)
		return await db_finish_request(ctx, request, {
			status: "blocked",
			message: refusal ?? "The job could not start. Make a new request.",
		});

	const run = (await ctx.db.get("files_archive_runs", runId))!;
	const activity = await activities_db_get_by_source_id(ctx, runId);
	await ctx.db.patch("files_trash_requests", request._id, { archiveRunId: runId, activityId: activity?._id ?? null });
	await files_trash_requests_db_settle_child(ctx, run);
}

export const advance = internalMutation({
	args: { batchId: v.id("files_trash_request_batches") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const batch = await ctx.db.get("files_trash_request_batches", args.batchId);
		if (!batch?.active) return null;

		// Access loss stops new work and lets the current job finish its repair.
		const now = Date.now();
		const membership = await db_get_batch_membership(ctx, batch);
		if (!membership) batch.stopping = true;
		await ctx.db.patch("files_trash_request_batches", batch._id, { stopping: batch.stopping, updatedAt: now });

		// Wait for the running child before starting another request.
		if (batch.currentRequestId) {
			const current = await ctx.db.get("files_trash_requests", batch.currentRequestId);
			const run = current?.archiveRunId ? await ctx.db.get("files_archive_runs", current.archiveRunId) : null;
			if (run?.active && batch.stopping)
				await files_archive_runs_db_request_stop(ctx, { runId: run._id, reason: "user", now });
			if (run) await files_trash_requests_db_settle_child(ctx, (await ctx.db.get("files_archive_runs", run._id))!);
			else if (current && current.status !== "finished")
				await db_finish_request(ctx, current, {
					status: "failed",
					message: "The job result is missing. Check Trash before making a new request.",
				});
			else {
				await ctx.db.patch("files_trash_request_batches", batch._id, { currentRequestId: null });
				await ctx.scheduler.runAfter(0, internal.files_trash_requests.advance, { batchId: batch._id });
			}
			return null;
		}

		// Release a stopped batch's claims one page at a time. Unapproved requests return to waiting.
		if (batch.step === "uploading" || batch.stopping) {
			if (!batch.stopping) return null;
			const requests = await ctx.db
				.query("files_trash_requests")
				.withIndex("by_batch_order", (q) => q.eq("batchId", batch._id))
				.take(PAGE_SIZE);
			for (const request of requests) {
				if (batch.step === "uploading" && request.outcome?.status === "canceled") {
					await db_delete_request(ctx, request);
					continue;
				}
				await ctx.db.patch("files_trash_requests", request._id, {
					batchId: null,
					batchOrder: null,
					status: request.status === "queued" ? (batch.step === "uploading" ? "waiting" : "finished") : request.status,
					...(request.status === "queued" &&
						batch.step !== "uploading" && {
							outcome: { status: "blocked" as const, message: "Workspace access changed. No new work was started." },
							expiresAt: now + files_DRAFT_IDLE_EXPIRY_MS,
						}),
					updatedAt: now,
				});
			}
			if (requests.length)
				await ctx.scheduler.runAfter(0, internal.files_trash_requests.advance, { batchId: batch._id });
			else await ctx.db.patch("files_trash_request_batches", batch._id, { active: false, step: "finished" });
			return null;
		}

		// A failed file review blocks later deletion, but independent restores can still run.
		if (batch.afterReviewRunId) {
			const activity = await activities_db_get_by_source_id(ctx, batch.afterReviewRunId);
			if (activity && activities_is_active(activity.status)) return null;
			if (activity?.status !== "succeeded")
				batch.destructiveBlockedReason =
					"The file review did not finish. Check its result, then ask for deletion again.";
			await ctx.db.patch("files_trash_request_batches", batch._id, {
				afterReviewRunId: null,
				destructiveBlockedReason: batch.destructiveBlockedReason,
			});
		}

		// Discard removes the requests without changing their files.
		if (batch.kind === "discard") {
			const requests = await ctx.db
				.query("files_trash_requests")
				.withIndex("by_batch_order", (q) => q.eq("batchId", batch._id))
				.take(PAGE_SIZE);
			for (const request of requests) await db_delete_request(ctx, request);
			if (requests.length)
				await ctx.scheduler.runAfter(0, internal.files_trash_requests.advance, { batchId: batch._id });
			else await ctx.db.patch("files_trash_request_batches", batch._id, { active: false, step: "finished" });
			return null;
		}

		// Run Restore, then Delete permanently, then Empty Trash, in creation order within each kind.
		const request = await ctx.db
			.query("files_trash_requests")
			.withIndex("by_batch_status_kind", (q) =>
				q.eq("batchId", batch._id).eq("status", "queued").eq("kind", batch.phase),
			)
			.first();
		if (!request) {
			if (batch.phase === "empty")
				await ctx.db.patch("files_trash_request_batches", batch._id, { active: false, step: "finished" });
			else {
				await ctx.db.patch("files_trash_request_batches", batch._id, {
					phase: batch.phase === "restore" ? "purge" : "empty",
				});
				await ctx.scheduler.runAfter(0, internal.files_trash_requests.advance, { batchId: batch._id });
			}
		} else if (request.kind !== "restore" && batch.destructiveBlockedReason)
			await db_finish_request(ctx, request, { status: "blocked", message: batch.destructiveBlockedReason });
		else await db_start_request(ctx, batch, request, membership!);
		return null;
	},
});

export const wake_review = internalMutation({
	args: { runId: v.id("files_pending_update_runs") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query("files_trash_request_batches")
			.withIndex("by_afterReviewRun", (q) => q.eq("afterReviewRunId", args.runId))
			.first();
		if (batch?.active) await ctx.scheduler.runAfter(0, internal.files_trash_requests.advance, { batchId: batch._id });
		return null;
	},
});

/**
 * A delayed Empty needs the archive's completion time, including after the normal history expiry.
 */
export async function files_trash_requests_db_hold_archive_history(ctx: MutationCtx, run: Doc<"files_archive_runs">) {
	if (run.kind !== "archive" || run.active) return false;
	const activity = await activities_db_get_by_source_id(ctx, run._id);
	if (activity?.finishedAt === undefined) return false;
	const batch = await ctx.db
		.query("files_trash_request_batches")
		.withIndex("by_org_ws_active_hasEmpty_approvedAt", (q) =>
			q
				.eq("organizationId", run.organizationId)
				.eq("workspaceId", run.workspaceId)
				.eq("active", true)
				.eq("hasEmpty", true)
				.gte("approvedAt", 0)
				.lte("approvedAt", activity.finishedAt!),
		)
		.first();
	if (!batch) return false;
	// Move this proof out of the due page so it cannot hold up unrelated history cleanup.
	// Check it again after the next recovery pass can release a stuck approval.
	await ctx.db.patch("activities", activity._id, { expiresAt: Date.now() + RECOVER_AFTER_MS });
	return true;
}

export const recover = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		for (const step of ["uploading", "running"] as const) {
			const batches = await ctx.db
				.query("files_trash_request_batches")
				.withIndex("by_step_updatedAt", (q) => q.eq("step", step).lte("updatedAt", now - RECOVER_AFTER_MS))
				.take(50);
			for (const batch of batches) {
				await ctx.db.patch("files_trash_request_batches", batch._id, {
					updatedAt: now,
					...(step === "uploading" && {
						stopping: true,
						errorMessage: "The selection upload expired. Select the requests again.",
					}),
				});
				await ctx.scheduler.runAfter(0, internal.files_trash_requests.advance, { batchId: batch._id });
			}
		}
		for (const status of ["waiting", "finished"] as const) {
			const requests = await ctx.db
				.query("files_trash_requests")
				.withIndex("by_status_expiresAt", (q) => q.eq("status", status).lte("expiresAt", now))
				.take(50);
			for (const request of requests) {
				const batch = request.batchId ? await ctx.db.get("files_trash_request_batches", request.batchId) : null;
				const activity = await ctx.db
					.query("users_last_active")
					.withIndex("by_user", (q) => q.eq("userId", request.userId))
					.first();
				const activeUntil = (activity?.lastActiveAt ?? 0) + files_DRAFT_IDLE_EXPIRY_MS;
				const membership = await organizations_db_get_membership(ctx, {
					userId: request.userId,
					membershipId: request.membershipId,
				});
				if (batch?.active || (membership && activeUntil > now))
					await ctx.db.patch("files_trash_requests", request._id, {
						expiresAt: batch?.active ? now + files_DRAFT_IDLE_EXPIRY_MS : activeUntil,
					});
				else await db_delete_request(ctx, request);
			}
		}
		const finished = await ctx.db
			.query("files_trash_request_batches")
			.withIndex("by_step_updatedAt", (q) => q.eq("step", "finished").lte("updatedAt", now - 7 * 24 * 60 * 60 * 1000))
			.take(50);
		for (const batch of finished) await ctx.db.delete("files_trash_request_batches", batch._id);
		return null;
	},
});

/**
 * Account/workspace deletion calls this before deleting its jobs and files.
 */
export async function files_trash_requests_db_delete_batch(
	ctx: MutationCtx,
	args: { userId: Id<"users"> } | { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	const batches = await (
		"userId" in args
			? ctx.db.query("files_trash_request_batches").withIndex("by_user", (q) => q.eq("userId", args.userId))
			: ctx.db
					.query("files_trash_request_batches")
					.withIndex("by_organization_workspace", (q) =>
						q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
					)
	).take(50);
	let deletedCount = 0;
	for (const batch of batches) {
		await ctx.db.patch("files_trash_request_batches", batch._id, { stopping: true });
		if (batch.currentRequestId) {
			const request = await ctx.db.get("files_trash_requests", batch.currentRequestId);
			if (request?.archiveRunId) {
				await files_archive_runs_db_request_stop(ctx, {
					runId: request.archiveRunId,
					reason: "user",
					now: Date.now(),
				});
				if ((await ctx.db.get("files_archive_runs", request.archiveRunId))?.active) continue;
			}
		}
		await ctx.db.delete("files_trash_request_batches", batch._id);
		deletedCount += 1;
	}
	if (batches.length) return { done: false, deletedCount };
	const requests = await (
		"userId" in args
			? ctx.db.query("files_trash_requests").withIndex("by_user", (q) => q.eq("userId", args.userId))
			: ctx.db
					.query("files_trash_requests")
					.withIndex("by_organization_workspace", (q) =>
						q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
					)
	).take(50);
	for (const request of requests) await db_delete_request(ctx, request);
	return { done: requests.length === 0, deletedCount: requests.length };
}
