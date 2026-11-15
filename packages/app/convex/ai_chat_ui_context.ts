import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { access_control_db_authorize_node } from "./access_control.ts";
import { channels_db_get_access } from "./channels.ts";
import { ai_chat_ui_context_validate_parts, type ai_chat_UiContext } from "../shared/ai-chat-ui-context.ts";

async function get_readable_node(
	ctx: QueryCtx | MutationCtx,
	membership: Doc<"organizations_workspaces_users">,
	fileNodeId: string,
) {
	const nodeId = ctx.db.normalizeId("files_nodes", fileNodeId);
	if (!nodeId) return null;
	const read = await access_control_db_authorize_node(ctx, {
		membership,
		userAuth: { id: membership.userId },
		nodeId,
		permission: "content.read",
	});
	return !read._nay && read._yay.fileNode.archiveOperationId === null ? read._yay.fileNode : null;
}

/**
 * The channel when the reader can open it now, with the same check every channel door uses.
 */
async function get_readable_channel(
	ctx: QueryCtx | MutationCtx,
	membership: Doc<"organizations_workspaces_users">,
	channelId: string,
) {
	const id = ctx.db.normalizeId("channels", channelId);
	const channel = id ? await ctx.db.get("channels", id) : null;
	if (!channel) return null;
	const access = await channels_db_get_access(ctx, { userAuth: { id: membership.userId }, membership, channel });
	return access._nay ? null : { channel, fileNode: access._yay.fileNode };
}

async function get_user_name(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
	const user = await ctx.db.get("users", userId);
	if (!user || user.deletedAt != null) return "Deleted user";
	const profile = user.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
	return profile?.displayName ?? "User";
}

/**
 * The channel name the Messages UI shows. A direct message has at most
 * `channels_LIMITS.directParticipants` people, so the name reads stay small.
 */
async function get_channel_name(
	ctx: QueryCtx | MutationCtx,
	membership: Doc<"organizations_workspaces_users">,
	readable: NonNullable<Awaited<ReturnType<typeof get_readable_channel>>>,
) {
	const { channel, fileNode } = readable;
	if (channel.kind === "file") return fileNode!.name;
	if (channel.kind !== "direct") return `#${channel.name}`;

	const names: string[] = [];
	for (const userId of channel.participantUserIds) {
		if (userId === membership.userId) continue;
		const participant = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", membership.workspaceId).eq("userId", userId).eq("active", true),
			)
			.unique();
		names.push(`${await get_user_name(ctx, userId)}${participant ? "" : " (left)"}`);
	}
	return names.join(", ") || "Direct message";
}

/**
 * The open thread when its root is a root of this channel that the reader can see now.
 */
async function get_readable_thread(
	ctx: QueryCtx | MutationCtx,
	membership: Doc<"organizations_workspaces_users">,
	channelId: Id<"channels">,
	threadRootId: string,
) {
	const id = ctx.db.normalizeId("channels_messages", threadRootId);
	const root = id ? await ctx.db.get("channels_messages", id) : null;
	if (!root || !root.listed || root.channelId !== channelId || root.threadRootId !== null) return null;
	const thread = await ctx.db
		.query("channels_threads")
		.withIndex("by_rootMessage", (q) => q.eq("rootMessageId", root._id))
		.unique();
	// An unsaved anchored comment is visible only to its author, like in `channels_messages_db_is_visible`.
	if (thread?.anchor && thread.anchor.confirmedAt === null && root.authorUserId !== membership.userId) return null;
	return { threadRootId: root._id, threadTitle: thread?.title ?? null };
}

/**
 * Check the screen info of a new message inside the send transaction, and return the message parts
 * to store. The stored path, kind and channel names come from the database, not from the browser.
 *
 * The app adds screen info by itself, so it never blocks a send. A node or channel the sender cannot
 * read now (archived, locked, another workspace, or an old message whose id history already cleared)
 * is dropped from the info instead.
 */
export async function ai_chat_ui_context_db_rewrite_parts(
	ctx: QueryCtx | MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users">; parts: unknown },
) {
	const context = ai_chat_ui_context_validate_parts(args.parts);
	if (context._nay) return context;
	const parts = args.parts as unknown[];
	if (!context._yay?.node && !context._yay?.channel) return Result({ _yay: parts });

	let node: ai_chat_UiContext["node"] = null;
	// A null id is the workspace root, which has no node doc.
	if (context._yay.node?.fileNodeId === null) {
		node = context._yay.node.path === "/" && context._yay.node.kind === "folder" ? context._yay.node : null;
	} else if (context._yay.node) {
		const fileNode = await get_readable_node(ctx, args.membership, context._yay.node.fileNodeId);
		node = fileNode ? { fileNodeId: fileNode._id, path: fileNode.path, kind: fileNode.kind } : null;
	}

	// A thread root that is not a visible root of the same channel becomes null.
	let channel: ai_chat_UiContext["channel"] = null;
	const sentChannel = context._yay.channel;
	const readable = sentChannel?.channelId
		? await get_readable_channel(ctx, args.membership, sentChannel.channelId)
		: null;
	if (sentChannel && readable) {
		const thread = sentChannel.threadRootId
			? await get_readable_thread(ctx, args.membership, readable.channel._id, sentChannel.threadRootId)
			: null;
		channel = {
			channelId: readable.channel._id,
			kind: readable.channel.kind,
			name: await get_channel_name(ctx, args.membership, readable),
			threadRootId: thread?.threadRootId ?? null,
			threadTitle: thread?.threadTitle ?? null,
		};
	}

	const data: ai_chat_UiContext = { ...context._yay, node, channel };
	return Result({
		_yay: parts.flatMap((part) => {
			if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "data-ui-context") {
				return [part];
			}
			// Info with no node, plugin or channel says nothing, so drop the whole part.
			return data.node || data.plugin || data.channel ? [{ ...part, data }] : [];
		}),
	});
}

/**
 * History reads keep the sent path and channel name, and clear a node id or channel ids the reader
 * can no longer open, like file quotes.
 */
export async function ai_chat_ui_context_db_shape(
	ctx: QueryCtx | MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users"> | null; context: ai_chat_UiContext },
) {
	const { membership, context } = args;
	let { node, channel } = context;
	if (node?.fileNodeId != null && !(membership && (await get_readable_node(ctx, membership, node.fileNodeId)))) {
		node = { ...node, fileNodeId: null };
	}
	if (channel?.channelId != null && !(membership && (await get_readable_channel(ctx, membership, channel.channelId)))) {
		channel = { ...channel, channelId: null, threadRootId: null };
	}
	return node === context.node && channel === context.channel ? context : { ...context, node, channel };
}
