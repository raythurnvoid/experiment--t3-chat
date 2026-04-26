import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { Result } from "../shared/errors-as-values-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";

async function chat_messages_db_get_membership(
	ctx: QueryCtx | MutationCtx,
	args: { membershipId: Id<"workspaces_projects_users">; userId: Id<"users"> },
) {
	const membership = await ctx.db.get("workspaces_projects_users", args.membershipId);
	if (!membership || membership.userId !== args.userId || membership.active === false) {
		return null;
	}

	return membership;
}

function chat_messages_has_membership_scope(
	message: Doc<"chat_messages">,
	membership: Doc<"workspaces_projects_users">,
) {
	return message.workspaceId === membership.workspaceId && message.projectId === membership.projectId;
}

/**
 * Creates a new root message (thread head) in the chat_messages table.
 *
 * @returns { threadId } - The ID of the newly created root message
 */
export const chat_messages_threads_create = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		content: v.string(),
	},
	returns: v_result({ _yay: v.object({ threadId: v.id("chat_messages") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await chat_messages_db_get_membership(ctx, { membershipId: args.membershipId, userId: userAuth.id });
		if (!membership) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "comments_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const threadId = await ctx.db.insert("chat_messages", {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			threadId: null,
			parentId: null,
			isArchived: false,
			createdBy: userAuth.name,
			content: args.content,
		});

		return Result({ _yay: { threadId } });
	},
});

/**
 * Appends a new child message to an existing thread root.
 *
 * @returns { messageId } - The ID of the newly created child message
 */
export const chat_messages_add = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		rootId: v.id("chat_messages"),
		content: v.string(),
	},
	returns: v_result({ _yay: v.object({ messageId: v.id("chat_messages") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await chat_messages_db_get_membership(ctx, { membershipId: args.membershipId, userId: userAuth.id });
		if (!membership) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const root = await ctx.db.get("chat_messages", args.rootId);
		if (!root) {
			return Result({ _nay: { message: "Root message not found" } });
		}

		if (!chat_messages_has_membership_scope(root, membership)) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "comments_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const messageId = await ctx.db.insert("chat_messages", {
			workspaceId: root.workspaceId,
			projectId: root.projectId,
			threadId: args.rootId,
			parentId: args.rootId,
			isArchived: false,
			createdBy: userAuth.name,
			content: args.content,
		});

		return Result({ _yay: { messageId } });
	},
});

/**
 * Lists messages in a thread using indexed reads.
 *
 * Returns root + children in oldest→newest order by Convex insertion order.
 */
export const chat_messages_list = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		threadId: v.id("chat_messages"),
		limit: v.number(),
	},
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await chat_messages_db_get_membership(ctx, { membershipId: args.membershipId, userId: userAuth.id });
		if (!membership) {
			return { messages: [] };
		}

		const root = await ctx.db.get("chat_messages", args.threadId);
		if (!root || root.isArchived || !chat_messages_has_membership_scope(root, membership)) {
			return { messages: [] };
		}

		const children = await ctx.db
			.query("chat_messages")
			.withIndex("by_workspace_project_thread", (q) =>
				q.eq("workspaceId", root.workspaceId).eq("projectId", root.projectId).eq("threadId", args.threadId),
			)
			.order("asc")
			.take(Math.max(0, args.limit - 1));

		const visibleChildren = children.filter((message) => !message.isArchived);

		return {
			messages: [root, ...visibleChildren],
		};
	},
});

/**
 * Soft archives a message by setting isArchived = true.
 */
export const chat_messages_archive = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		messageId: v.id("chat_messages"),
	},
	returns: v_result({ _yay: v.object({ success: v.boolean() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await chat_messages_db_get_membership(ctx, { membershipId: args.membershipId, userId: userAuth.id });
		if (!membership) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const message = await ctx.db.get("chat_messages", args.messageId);
		if (!message) {
			return Result({ _nay: { message: "Message not found" } });
		}

		if (!chat_messages_has_membership_scope(message, membership)) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "comments_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		await ctx.db.patch("chat_messages", args.messageId, {
			isArchived: true,
		});

		return Result({ _yay: { success: true } });
	},
});

/**
 * Gets a single message by ID.
 */
export const chat_messages_get = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		messageId: v.id("chat_messages"),
	},
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await chat_messages_db_get_membership(ctx, { membershipId: args.membershipId, userId: userAuth.id });
		if (!membership) {
			return null;
		}

		const message = await ctx.db.get("chat_messages", args.messageId);
		if (!message || !chat_messages_has_membership_scope(message, membership)) {
			return null;
		}

		return message;
	},
});

/**
 * Lists thread heads for the given IDs.
 */
export const chat_messages_threads_list = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		threadIds: v.array(v.string()),
		isArchived: v.optional(v.union(v.boolean(), v.null())),
	},
	returns: {
		threads: v.array(
			v.object({
				id: v.id("chat_messages"),
				createdAt: v.number(),
				lastMessageAt: v.number(),
				content: v.string(),
				createdBy: v.string(),
				isArchived: v.boolean(),
			}),
		),
	},
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await chat_messages_db_get_membership(ctx, { membershipId: args.membershipId, userId: userAuth.id });
		if (!membership) {
			return { threads: [] };
		}

		const threadIds = args.threadIds
			.map((threadId) => ctx.db.normalizeId("chat_messages", threadId))
			.filter((threadId) => threadId != null);

		const threads = await Promise.all(
			threadIds.map((threadId) =>
				ctx.db.get("chat_messages", threadId).then(async (message) => {
					if (!message) {
						return null;
					}

					if (!chat_messages_has_membership_scope(message, membership)) {
						return null;
					}

					if (args.isArchived !== undefined && args.isArchived !== null) {
						if (message.isArchived !== args.isArchived) {
							return null;
						}
					}

					const lastChild = await ctx.db
						.query("chat_messages")
						.withIndex("by_workspace_project_thread", (q) =>
							q.eq("workspaceId", message.workspaceId).eq("projectId", message.projectId).eq("threadId", message._id),
						)
						.order("desc")
						.first();

					const lastMessageAt = lastChild?._creationTime ?? message._creationTime;

					return {
						id: message._id,
						createdAt: message._creationTime,
						lastMessageAt,
						content: message.content,
						createdBy: message.createdBy,
						isArchived: message.isArchived,
					};
				}),
			),
		).then((values) => values.filter((value) => value != null));

		return { threads };
	},
});
