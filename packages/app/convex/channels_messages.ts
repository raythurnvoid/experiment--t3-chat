import { v, type Infer } from "convex/values";
import { paginationOptsValidator, paginationResultValidator, type PaginationOptions } from "convex/server";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import { internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation, mutation } from "./functions.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import app_convex_schema, { ai_chat_workspaces_source_validator, file_quote_validator } from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { ai_chat_workspaces_db_authorize_file_scope } from "./ai_chat_workspaces.ts";
import { access_control_db_authorize_node } from "./access_control.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	channels_db_get_access,
	channels_db_add_member,
	channels_db_ensure_file_channel,
	channels_db_mark_read,
} from "./channels.ts";
import {
	channels_LIMITS,
	channels_is_emoji,
	channels_markdown_to_plain_text,
	channels_render_people_mentions,
	channels_render_file_mentions,
	channels_render_file_quotes,
	channels_search_query_schema,
} from "../shared/channels.ts";
import { file_quotes_db_shape, file_quotes_db_validate } from "./file_quotes.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { files_nodes_db_require_user_writable } from "./files_nodes.ts";
import { files_db_get_visible_node_by_path } from "../server/files.ts";

// Make Convex reuse the loaded module between calls. No mutable module state is allowed here.
export const experimental_reuseContext = true;

const shaped_file_reference_validator = v.union(
	v.object({ kind: v.literal("file"), fileNodeId: v.id("files_nodes"), name: v.string(), path: v.string() }),
	v.object({ kind: v.literal("unavailable") }),
);

const shaped_message_validator = v.object({
	message: doc(app_convex_schema, "channels_messages"),
	authorName: v.string(),
	mentionNames: v.array(v.string()),
	fileMentions: v.array(shaped_file_reference_validator),
	attachments: v.array(
		v.union(
			shaped_file_reference_validator,
			v.object({
				kind: v.literal("upload"),
				uploadId: v.id("channels_uploads"),
				name: v.string(),
				contentType: v.string(),
				size: v.number(),
			}),
		),
	),
	replyPreview: v.union(
		v.null(),
		v.object({
			authorName: v.string(),
			excerpt: v.string(),
			targetDeleted: v.boolean(),
			targetThreadRootId: v.union(v.id("channels_messages"), v.null()),
		}),
	),
	thread: v.union(doc(app_convex_schema, "channels_threads"), v.null()),
});

function is_posts(channel: Doc<"channels">) {
	return (
		channel.kind === "file" || ((channel.kind === "public" || channel.kind === "private") && channel.layout === "posts")
	);
}

async function get_context(ctx: QueryCtx | MutationCtx, membershipId: Id<"organizations_workspaces_users">) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
	const user = await ctx.db.get("users", userAuth.id);
	if (!user || user.deletedAt != null) return Result({ _nay: { message: "Unauthenticated" } });
	const membership = await organizations_db_get_membership(ctx, {
		membershipId,
		userId: userAuth.id,
	});
	if (!membership) return Result({ _nay: { message: "Not found" } });
	return Result({ _yay: { userAuth, membership } });
}

async function get_name(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
	const user = await ctx.db.get("users", userId);
	if (!user || user.deletedAt != null) return "Deleted user";
	const profile = user.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
	return profile?.displayName ?? "User";
}

async function get_thread(ctx: QueryCtx | MutationCtx, rootMessageId: Id<"channels_messages">) {
	return ctx.db
		.query("channels_threads")
		.withIndex("by_rootMessage", (q) => q.eq("rootMessageId", rootMessageId))
		.unique();
}

async function shape_file_mentions(
	ctx: QueryCtx | MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users">; fileMentionIds: readonly Id<"files_nodes">[] },
) {
	return await Promise.all(
		args.fileMentionIds.map(async (fileNodeId) => {
			const read = await access_control_db_authorize_node(ctx, {
				membership: args.membership,
				userAuth: { id: args.membership.userId },
				nodeId: fileNodeId,
				permission: "content.read",
			});
			return read._nay || read._yay.fileNode.archiveOperationId !== null
				? { kind: "unavailable" as const }
				: { kind: "file" as const, fileNodeId, name: read._yay.fileNode.name, path: read._yay.fileNode.path };
		}),
	);
}

async function get_plain_text(
	ctx: QueryCtx | MutationCtx,
	message: Doc<"channels_messages">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const names = await Promise.all(message.mentionUserIds.map((userId) => get_name(ctx, userId)));
	const files = await shape_file_mentions(ctx, { membership, fileMentionIds: message.fileMentionIds });
	return channels_markdown_to_plain_text(
		channels_render_file_quotes(
			channels_render_file_mentions(
				channels_render_people_mentions(message.body, names),
				files.map((file) => (file.kind === "file" ? { name: file.name } : null)),
			),
			message.fileQuotes,
		),
	);
}

export async function channels_messages_db_is_visible(
	ctx: QueryCtx | MutationCtx,
	message: Doc<"channels_messages">,
	userId: Id<"users">,
) {
	const thread = await get_thread(ctx, message.threadRootId ?? message._id);
	if (thread?.anchor && thread.anchor.confirmedAt === null && message.authorUserId !== userId) return false;
	return message.deletedAt === null || (message.threadRootId === null && (thread?.replyCount ?? 0) > 0);
}

async function get_message_context(
	ctx: QueryCtx | MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		messageId: Id<"channels_messages">;
	},
) {
	const message = await ctx.db.get("channels_messages", args.messageId);
	if (!message) return Result({ _nay: { message: "Not found" } });
	const channel = await ctx.db.get("channels", message.channelId);
	if (!channel) return Result({ _nay: { message: "Not found" } });
	const access = await channels_db_get_access(ctx, { ...args, channel });
	if (access._nay) return access;
	if (!(await channels_messages_db_is_visible(ctx, message, args.userAuth.id)))
		return Result({ _nay: { message: "Not found" } });
	const thread = await get_thread(ctx, message.threadRootId ?? message._id);
	return Result({ _yay: { message, channel, access: access._yay, thread } });
}

async function get_message_write_context(
	ctx: MutationCtx,
	args: {
		membershipId: Id<"organizations_workspaces_users">;
		messageId: Id<"channels_messages">;
	},
	name: "channels_message_write" | "channels_reaction_write" | "channels_write",
) {
	const context = await get_context(ctx, args.membershipId);
	if (context._nay) return context;
	const limit = await rate_limiter_limit_by_key(ctx, {
		name,
		key: context._yay.userAuth.id,
	});
	if (limit) return Result({ _nay: { message: limit.message } });
	const target = await get_message_context(ctx, {
		...context._yay,
		messageId: args.messageId,
	});
	if (target._nay) return target;
	if (!target._yay.access.canPost) return Result({ _nay: { message: target._yay.access.postRefusal! } });
	if (target._yay.thread?.anchor?.confirmedAt === null)
		return Result({ _nay: { message: "This comment is still being added" } });
	return Result({ _yay: { ...context._yay, ...target._yay } });
}

async function can_mention(
	ctx: QueryCtx | MutationCtx,
	args: {
		membership: Pick<Doc<"organizations_workspaces_users">, "organizationId" | "workspaceId">;
		channel: Doc<"channels"> | null;
		fileNodeId: Id<"files_nodes"> | null;
		userId: Id<"users">;
	},
) {
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_workspace_user_active", (q) =>
			q.eq("workspaceId", args.membership.workspaceId).eq("userId", args.userId).eq("active", true),
		)
		.unique();
	if (!membership || membership.organizationId !== args.membership.organizationId) return false;
	if (args.channel) {
		const access = await channels_db_get_access(ctx, {
			channel: args.channel,
			membership,
			userAuth: { id: args.userId },
		});
		return (
			!access._nay &&
			((args.channel.kind !== "private" && args.channel.kind !== "direct") || access._yay.member !== null)
		);
	}
	const read = await access_control_db_authorize_node(ctx, {
		userAuth: { id: args.userId },
		membership,
		nodeId: args.fileNodeId!,
		permission: "content.read",
	});
	return !read._nay;
}

async function validate_mentions(
	ctx: QueryCtx | MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		channel: Doc<"channels"> | null;
		fileNodeId: Id<"files_nodes"> | null;
		mentionUserIds: Id<"users">[];
	},
) {
	if (args.mentionUserIds.length > channels_LIMITS.mentions)
		return Result({ _nay: { message: "Mention at most 50 people" } });
	const ids = [...new Set(args.mentionUserIds)];
	for (const userId of ids) {
		if (!(await can_mention(ctx, { ...args, userId }))) {
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", args.membership.workspaceId).eq("userId", userId).eq("active", true),
				)
				.unique();
			const name =
				membership?.organizationId === args.membership.organizationId ? await get_name(ctx, userId) : "Person";
			return Result({ _nay: { message: `${name} cannot see this channel` } });
		}
	}
	return Result({ _yay: ids });
}

async function validate_file_references(
	ctx: MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		body: string;
		fileMentionIds: Id<"files_nodes">[];
		fileQuotes: Infer<typeof file_quote_validator>[];
	},
) {
	if (
		args.fileMentionIds.length > channels_LIMITS.mentions ||
		new Set(args.fileMentionIds).size !== args.fileMentionIds.length
	)
		return Result({ _nay: { message: "Mention at most 50 different files" } });
	for (const match of args.body.matchAll(/\[@ id="file:([^"]+)"\]/g)) {
		if (!/^\d+$/.test(match[1]!) || Number(match[1]) >= args.fileMentionIds.length)
			return Result({ _nay: { message: "Invalid file mentions" } });
	}
	const quotes = await file_quotes_db_validate(ctx, { membership: args.membership, quotes: args.fileQuotes });
	if (quotes._nay) return quotes;
	// Private draft data must never become the public message body.
	const tokens = [...args.body.matchAll(/\[file-quote\b[^\]]*\]/g)];
	if (tokens.length !== quotes._yay.length || tokens.some((token, index) => token[0] !== `[file-quote id="${index}"]`))
		return Result({ _nay: { message: "Invalid file quotes" } });
	if (
		files_get_utf8_byte_size(args.body) +
			quotes._yay.reduce((bytes, quote) => bytes + files_get_utf8_byte_size(quote.text), 0) >
		channels_LIMITS.bodyBytes
	)
		return Result({ _nay: { message: "Message is too long" } });
	for (const nodeId of args.fileMentionIds) {
		const read = await access_control_db_authorize_node(ctx, {
			membership: args.membership,
			userAuth: { id: args.membership.userId },
			nodeId,
			permission: "content.read",
		});
		if (read._nay || read._yay.fileNode.archiveOperationId !== null)
			return Result({ _nay: { message: "File unavailable" } });
	}
	return quotes;
}

async function ensure_thread(
	ctx: MutationCtx,
	root: Doc<"channels_messages">,
	args: {
		title?: string | null;
		anchor?: Doc<"channels_threads">["anchor"];
	} = {},
) {
	const existing = await get_thread(ctx, root._id);
	if (existing) return existing;
	const threadId = await ctx.db.insert("channels_threads", {
		channelId: root.channelId,
		organizationId: root.organizationId,
		workspaceId: root.workspaceId,
		rootMessageId: root._id,
		title: args.title ?? null,
		anchor: args.anchor ?? null,
		lastReplySequence: 0,
		lastActivitySequence: root.channelSequence,
		replyCount: 0,
		recentReplierUserIds: [],
		lastActivityAt: root._creationTime,
		isResolved: false,
		resolvedAt: null,
		resolvedBy: null,
		followerSyncPending: false,
	});
	const thread = (await ctx.db.get("channels_threads", threadId))!;
	if ((!args.anchor || args.anchor.confirmedAt !== null) && root.mentionUserIds.length) {
		const channel = (await ctx.db.get("channels", root.channelId))!;
		for (const userId of root.mentionUserIds) {
			if (
				userId !== root.authorUserId &&
				(await can_mention(ctx, {
					membership: root,
					channel,
					fileNodeId: null,
					userId,
				}))
			) {
				await follow(ctx, { thread, userId, readReplySequence: 0 });
			}
		}
	}
	return thread;
}

async function follow(
	ctx: MutationCtx,
	args: {
		thread: Doc<"channels_threads">;
		userId: Id<"users">;
		readReplySequence: number;
		pendingRootMention?: boolean;
		markRead?: boolean;
	},
) {
	const { thread, userId } = args;
	const existing = await ctx.db
		.query("channels_thread_followers")
		.withIndex("by_thread_user", (q) => q.eq("threadId", thread._id).eq("userId", userId))
		.unique();
	if (existing) {
		await ctx.db.patch("channels_thread_followers", existing._id, {
			following: true,
			threadLastActivityAt: thread.lastActivityAt,
			...(args.markRead
				? {
						readReplySequence: Math.max(existing.readReplySequence, args.readReplySequence),
						pendingRootMention: false,
					}
				: {}),
			...(args.pendingRootMention ? { pendingRootMention: true } : {}),
		});
	} else {
		await ctx.db.insert("channels_thread_followers", {
			threadId: thread._id,
			rootMessageId: thread.rootMessageId,
			channelId: thread.channelId,
			organizationId: thread.organizationId,
			workspaceId: thread.workspaceId,
			userId,
			readReplySequence: args.readReplySequence,
			following: true,
			pendingRootMention: args.pendingRootMention ?? false,
			threadLastActivityAt: thread.lastActivityAt,
			followedAt: Date.now(),
		});
	}
}

async function notify(
	ctx: MutationCtx,
	args: {
		message: Doc<"channels_messages">;
		channel: Doc<"channels">;
		thread: Doc<"channels_threads"> | null;
		replyAuthorUserId: Id<"users"> | null;
	},
) {
	const { message, thread, channel } = args;
	const recipients = [
		...message.mentionUserIds.map((userId) => ({
			userId,
			kind: "mention" as const,
		})),
		...(args.replyAuthorUserId ? [{ userId: args.replyAuthorUserId, kind: "reply" as const }] : []),
	];
	for (const { userId, kind } of recipients) {
		if (userId === message.authorUserId) continue;
		if (
			!(await can_mention(ctx, {
				membership: message,
				channel,
				fileNodeId: null,
				userId,
			}))
		)
			continue;
		if (thread)
			await follow(ctx, {
				thread,
				userId,
				readReplySequence: Math.max(0, (message.threadSequence ?? 0) - 1),
				pendingRootMention: is_posts(channel) && message.threadRootId === null,
			});
		await ctx.db.insert("channels_inbox", {
			recipientUserId: userId,
			organizationId: message.organizationId,
			workspaceId: message.workspaceId,
			channelId: message.channelId,
			messageId: message._id,
			kind,
			mainSequence: message.mainSequence,
			threadRootId: message.threadRootId ?? (is_posts(channel) ? message._id : null),
			threadSequence: message.threadSequence ?? (is_posts(channel) ? 0 : null),
			createdAt: message._creationTime,
		});
	}
}

export const send_message = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		target: v.union(
			v.object({ kind: v.literal("channel"), channelId: v.id("channels") }),
			v.object({
				kind: v.literal("thread"),
				rootMessageId: v.id("channels_messages"),
			}),
			v.object({
				kind: v.literal("file_comment"),
				fileNodeId: v.id("files_nodes"),
				anchorExcerpt: v.union(v.string(), v.null()),
			}),
		),
		clientMessageId: v.string(),
		body: v.string(),
		mentionUserIds: v.array(v.id("users")),
		fileMentionIds: v.array(v.id("files_nodes")),
		fileQuotes: v.array(file_quote_validator),
		replyTo: v.union(
			v.object({
				messageId: v.id("channels_messages"),
				quote: v.union(v.string(), v.null()),
			}),
			v.null(),
		),
		attachments: app_convex_schema.tables.channels_messages.validator.fields.attachments,
		alsoInChannel: v.boolean(),
		title: v.union(v.string(), v.null()),
	},
	returns: v_result({
		_yay: v.object({
			messageId: v.id("channels_messages"),
			rootMessageId: v.id("channels_messages"),
		}),
	}),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) return context;
		const { membership, userAuth } = context._yay;
		const limit = await rate_limiter_limit_by_key(ctx, {
			name: "channels_message_write",
			key: userAuth.id,
		});
		if (limit) return Result({ _nay: { message: limit.message } });
		let channel: Doc<"channels"> | null = null;
		let root: Doc<"channels_messages"> | null = null;
		let thread: Doc<"channels_threads"> | null = null;
		if (args.target.kind === "file_comment") {
			const read = await access_control_db_authorize_node(ctx, {
				membership,
				userAuth,
				nodeId: args.target.fileNodeId,
				permission: "content.read",
			});
			if (read._nay) return Result({ _nay: { message: "Not found" } });
			const write = await access_control_db_authorize_node(ctx, {
				membership,
				userAuth,
				nodeId: args.target.fileNodeId,
				permission: "content.write",
			});
			if (write._nay) return write;
			const file = read._yay.fileNode;
			if (file.kind !== "file" || file.archiveOperationId !== null)
				return Result({
					_nay: { message: "This file cannot have new comments" },
				});
			const asset = file.assetId ? await ctx.db.get("files_r2_assets", file.assetId) : null;
			if (asset?.kind === "upload" && !asset.r2Key)
				return Result({
					_nay: { message: "Wait for the file upload to finish" },
				});
			if (args.target.anchorExcerpt !== null && args.target.anchorExcerpt.length > channels_LIMITS.anchorExcerpt)
				return Result({ _nay: { message: "Selected text is too long" } });
			if (args.target.anchorExcerpt !== null) {
				const writable = await files_nodes_db_require_user_writable(ctx, {
					node: file,
					userId: userAuth.id,
				});
				if (writable._nay) return writable;
			}
			const fileNodeId = args.target.fileNodeId;
			channel = await ctx.db
				.query("channels")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("fileNodeId", fileNodeId),
				)
				.unique();
		} else {
			if (args.target.kind === "thread") {
				root = await ctx.db.get("channels_messages", args.target.rootMessageId);
				if (!root || root.threadRootId !== null) return Result({ _nay: { message: "Not found" } });
				thread = await get_thread(ctx, root._id);
				if (root.deletedAt !== null && !thread) return Result({ _nay: { message: "Not found" } });
			}
			channel = await ctx.db.get(
				"channels",
				root?.channelId ?? (args.target.kind === "channel" ? args.target.channelId : null)!,
			);
			if (!channel) return Result({ _nay: { message: "Not found" } });
			const access = await channels_db_get_access(ctx, {
				membership,
				userAuth,
				channel,
			});
			if (access._nay) return access;
			if (!access._yay.canPost) return Result({ _nay: { message: access._yay.postRefusal! } });
			if (thread?.anchor?.confirmedAt === null)
				return Result({
					_nay: { message: "This comment is still being added" },
				});
		}
		if (files_get_utf8_byte_size(args.body) > channels_LIMITS.bodyBytes)
			return Result({ _nay: { message: "Message is too long" } });
		if (!args.body.trim() && !args.attachments.length)
			return Result({ _nay: { message: "Write a message or add a file" } });
		if (args.clientMessageId.length === 0 || args.clientMessageId.length > 128)
			return Result({ _nay: { message: "Invalid message id" } });
		const retry = await ctx.db
			.query("channels_messages")
			.withIndex("by_author_clientMessageId", (q) =>
				q.eq("authorUserId", userAuth.id).eq("clientMessageId", args.clientMessageId),
			)
			.unique();
		if (retry) {
			if (retry.channelId !== channel?._id || retry.threadRootId !== (root?._id ?? null))
				return Result({ _nay: { message: "Message id is already used" } });
			// The message is already sent. Changed file access must not make a retry publish twice.
			return Result({ _yay: { messageId: retry._id, rootMessageId: retry.threadRootId ?? retry._id } });
		}
		if (args.title !== null && (args.title.length > channels_LIMITS.title || root || (channel && !is_posts(channel))))
			return Result({ _nay: { message: "Only posts can have a title" } });
		if (args.alsoInChannel && (!root || !channel || is_posts(channel)))
			return Result({
				_nay: { message: "Only thread replies can also appear in the channel" },
			});
		const mentions = await validate_mentions(ctx, {
			membership,
			channel,
			fileNodeId: args.target.kind === "file_comment" ? args.target.fileNodeId : null,
			mentionUserIds: args.mentionUserIds,
		});
		if (mentions._nay) return mentions;
		const fileReferences = await validate_file_references(ctx, { ...args, membership });
		if (fileReferences._nay) return fileReferences;
		if (args.attachments.length > channels_LIMITS.attachments)
			return Result({ _nay: { message: "Attach at most 20 files" } });
		const uploads: Doc<"channels_uploads">[] = [];
		const uploadIds = new Set<Id<"channels_uploads">>();
		for (const attachment of args.attachments) {
			if (attachment.kind === "upload") {
				if (uploadIds.has(attachment.uploadId)) return Result({ _nay: { message: "Attach each upload once" } });
				uploadIds.add(attachment.uploadId);
				const upload = await ctx.db.get("channels_uploads", attachment.uploadId);
				if (
					!upload ||
					upload.organizationId !== membership.organizationId ||
					upload.workspaceId !== membership.workspaceId ||
					upload.channelId !== channel?._id ||
					upload.uploaderUserId !== userAuth.id
				)
					return Result({ _nay: { message: "Upload unavailable" } });
				if (upload.messageId !== null) return Result({ _nay: { message: "This upload is already attached" } });
				const asset = await ctx.db.get("files_r2_assets", upload.assetId);
				if (
					!asset ||
					asset.kind !== "channel_upload" ||
					asset.organizationId !== membership.organizationId ||
					asset.workspaceId !== membership.workspaceId
				)
					return Result({ _nay: { message: "Upload unavailable" } });
				if (asset.r2Key === undefined) return Result({ _nay: { message: "Wait for the file upload to finish" } });
				if (asset.unfinalizedExpiresAt !== undefined && asset.unfinalizedExpiresAt <= Date.now())
					return Result({ _nay: { message: "This upload expired" } });
				uploads.push(upload);
				continue;
			}
			const read = await access_control_db_authorize_node(ctx, {
				membership,
				userAuth,
				nodeId: attachment.fileNodeId,
				permission: "content.read",
			});
			if (read._nay || read._yay.fileNode.kind !== "file") return Result({ _nay: { message: "File unavailable" } });
			const asset = read._yay.fileNode.assetId ? await ctx.db.get("files_r2_assets", read._yay.fileNode.assetId) : null;
			if (asset?.kind === "upload" && !asset.r2Key)
				return Result({
					_nay: { message: "Wait for the file upload to finish" },
				});
		}
		let replyTarget: Doc<"channels_messages"> | null = null;
		if (args.replyTo) {
			replyTarget = await ctx.db.get("channels_messages", args.replyTo.messageId);
			if (
				!replyTarget ||
				!channel ||
				replyTarget.channelId !== channel._id ||
				replyTarget.deletedAt !== null ||
				!(await channels_messages_db_is_visible(ctx, replyTarget, userAuth.id))
			)
				return Result({ _nay: { message: "Original message not found" } });
			if (is_posts(channel) && (!root || (replyTarget.threadRootId ?? replyTarget._id) !== root._id))
				return Result({ _nay: { message: "Reply inside the same post" } });
			if (args.replyTo.quote !== null) {
				const plain = await get_plain_text(ctx, replyTarget, membership);
				if (plain._nay || args.replyTo.quote.length > channels_LIMITS.quote || !plain._yay.includes(args.replyTo.quote))
					return Result({
						_nay: { message: "Quote is not part of the original message" },
					});
			}
		}
		// All refusals are above this line. A new file channel is part of this send transaction.
		if (!channel && args.target.kind === "file_comment")
			channel = await channels_db_ensure_file_channel(ctx, {
				membership,
				fileNodeId: args.target.fileNodeId,
				userId: userAuth.id,
			});
		const currentChannel = channel!;
		const activity = (await ctx.db
			.query("channels_activity")
			.withIndex("by_channel", (q) => q.eq("channelId", currentChannel._id))
			.unique())!;
		const read = await ctx.db
			.query("channels_read_states")
			.withIndex("by_channel_user", (q) => q.eq("channelId", currentChannel._id).eq("userId", userAuth.id))
			.unique();
		const unconfirmed = args.target.kind === "file_comment" && args.target.anchorExcerpt !== null;
		// An unsaved mark has no public sequence until confirmation.
		const channelSequence = unconfirmed ? 0 : activity.lastChannelSequence + 1;
		const mainSequence = !unconfirmed && (!root || args.alsoInChannel) ? activity.lastMainSequence + 1 : null;
		if (root && !thread) thread = await ensure_thread(ctx, root);
		const threadSequence = root ? thread!.lastReplySequence + 1 : null;
		const messageId = await ctx.db.insert("channels_messages", {
			channelId: currentChannel._id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			authorUserId: userAuth.id,
			channelSequence,
			mainSequence,
			threadRootId: root?._id ?? null,
			threadSequence,
			replyTo: args.replyTo,
			body: args.body,
			mentionUserIds: mentions._yay,
			fileMentionIds: args.fileMentionIds,
			fileQuotes: fileReferences._yay,
			attachments: args.attachments,
			hasAttachments: args.attachments.length > 0,
			clientMessageId: args.clientMessageId,
			revision: 0,
			editedAt: null,
			deletedAt: null,
		});
		for (const upload of uploads) {
			await ctx.db.patch("channels_uploads", upload._id, { messageId });
			await ctx.db.patch("files_r2_assets", upload.assetId, { unfinalizedExpiresAt: undefined });
		}
		const message = (await ctx.db.get("channels_messages", messageId))!;
		if (!unconfirmed)
			await ctx.db.patch("channels_activity", activity._id, {
				lastChannelSequence: channelSequence,
				lastMainSequence: mainSequence ?? activity.lastMainSequence,
				lastMessageAt: message._creationTime,
			});
		if (!root && is_posts(currentChannel)) {
			thread = await ensure_thread(ctx, message, {
				title: args.title,
				anchor: unconfirmed
					? {
							kind: "text_mark",
							excerpt: args.target.kind === "file_comment" ? args.target.anchorExcerpt! : "",
							confirmedAt: null,
						}
					: null,
			});
		} else if (root && thread) {
			await ctx.db.patch("channels_threads", thread._id, {
				lastReplySequence: threadSequence!,
				lastActivitySequence: channelSequence,
				replyCount: thread.replyCount + 1,
				recentReplierUserIds: [userAuth.id, ...thread.recentReplierUserIds.filter((id) => id !== userAuth.id)].slice(
					0,
					3,
				),
				lastActivityAt: message._creationTime,
				isResolved: false,
				resolvedAt: null,
				resolvedBy: null,
				followerSyncPending: true,
			});
			if (!thread.followerSyncPending)
				await ctx.scheduler.runAfter(0, internal.channels_messages.sync_thread_followers, {
					threadId: thread._id,
					cursor: null,
					activityAt: message._creationTime,
				});
			thread = (await ctx.db.get("channels_threads", thread._id))!;
		}
		if (thread && !unconfirmed) {
			if (root)
				await follow(ctx, {
					thread,
					userId: root.authorUserId,
					readReplySequence: 0,
				});
			await follow(ctx, {
				thread,
				userId: userAuth.id,
				readReplySequence: thread.lastReplySequence,
				markRead: true,
			});
		}
		if (!unconfirmed) {
			if (currentChannel.kind === "file")
				await channels_db_add_member(ctx, {
					channel: currentChannel,
					membership,
					level: "member",
					addedBy: null,
				});
			await notify(ctx, {
				message,
				channel: currentChannel,
				thread,
				replyAuthorUserId: replyTarget?.authorUserId ?? null,
			});
		}
		if (!unconfirmed && (!is_posts(currentChannel) || (read?.readSequence ?? 0) === activity.lastChannelSequence)) {
			await channels_db_mark_read(ctx, {
				channel: currentChannel,
				userId: userAuth.id,
				sequence: is_posts(currentChannel) ? channelSequence : (mainSequence ?? activity.lastMainSequence),
			});
		}
		return Result({
			_yay: { messageId, rootMessageId: root?._id ?? messageId },
		});
	},
});

export const sync_thread_followers = internalMutation({
	args: {
		threadId: v.id("channels_threads"),
		cursor: v.union(v.string(), v.null()),
		activityAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const thread = await ctx.db.get("channels_threads", args.threadId);
		if (!thread) return null;
		const followers = await ctx.db
			.query("channels_thread_followers")
			.withIndex("by_thread", (q) => q.eq("threadId", thread._id))
			.paginate({ cursor: args.cursor, numItems: 100 });
		for (const follower of followers.page)
			await ctx.db.patch("channels_thread_followers", follower._id, {
				threadLastActivityAt: thread.lastActivityAt,
			});
		if (!followers.isDone)
			await ctx.scheduler.runAfter(0, internal.channels_messages.sync_thread_followers, {
				...args,
				cursor: followers.continueCursor,
			});
		else if (thread.lastActivityAt !== args.activityAt)
			await ctx.scheduler.runAfter(0, internal.channels_messages.sync_thread_followers, {
				threadId: thread._id,
				cursor: null,
				activityAt: thread.lastActivityAt,
			});
		else
			await ctx.db.patch("channels_threads", thread._id, {
				followerSyncPending: false,
			});
		return null;
	},
});

async function shape_message(
	ctx: QueryCtx,
	args: {
		message: Doc<"channels_messages">;
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
	},
) {
	const { message } = args;
	if (!(await channels_messages_db_is_visible(ctx, message, args.userAuth.id))) return null;
	const attachments: Infer<typeof shaped_message_validator.fields.attachments> = [];
	for (const attachment of message.attachments) {
		if (attachment.kind === "upload") {
			const upload = await ctx.db.get("channels_uploads", attachment.uploadId);
			const asset = upload ? await ctx.db.get("files_r2_assets", upload.assetId) : null;
			attachments.push(
				upload &&
					upload.messageId === message._id &&
					upload.channelId === message.channelId &&
					upload.organizationId === message.organizationId &&
					upload.workspaceId === message.workspaceId &&
					asset?.kind === "channel_upload" &&
					asset.r2Key !== undefined &&
					message.deletedAt === null
					? {
							kind: "upload",
							uploadId: upload._id,
							name: upload.name,
							contentType: upload.contentType,
							size: asset.size,
						}
					: { kind: "unavailable" },
			);
			continue;
		}
		const read = await access_control_db_authorize_node(ctx, {
			...args,
			nodeId: attachment.fileNodeId,
			permission: "content.read",
		});
		attachments.push(
			read._nay
				? { kind: "unavailable" }
				: {
						kind: "file",
						fileNodeId: attachment.fileNodeId,
						name: read._yay.fileNode.name,
						path: read._yay.fileNode.path,
					},
		);
	}
	let replyPreview: {
		authorName: string;
		excerpt: string;
		targetDeleted: boolean;
		targetThreadRootId: Id<"channels_messages"> | null;
	} | null = null;
	if (message.replyTo) {
		const target = await ctx.db.get("channels_messages", message.replyTo.messageId);
		if (target && target.channelId === message.channelId) {
			const plain = target.deletedAt === null ? await get_plain_text(ctx, target, args.membership) : null;
			const quote = message.replyTo.quote;
			replyPreview = {
				authorName: await get_name(ctx, target.authorUserId),
				excerpt: plain?._yay ? (quote && plain._yay.includes(quote) ? quote : plain._yay.slice(0, 140)) : "",
				targetDeleted: target.deletedAt !== null,
				targetThreadRootId: target.threadRootId,
			};
		}
	}
	// Raw attachment ids and stale inline quotes must not bypass the shaped fields.
	return {
		message: {
			...message,
			fileMentionIds: [],
			fileQuotes: await file_quotes_db_shape(ctx, { membership: args.membership, quotes: message.fileQuotes }),
			attachments: [],
			replyTo: message.replyTo
				? {
						...message.replyTo,
						quote: replyPreview?.targetDeleted
							? null
							: replyPreview?.excerpt === message.replyTo.quote
								? message.replyTo.quote
								: null,
					}
				: null,
		},
		authorName: await get_name(ctx, message.authorUserId),
		mentionNames: await Promise.all(message.mentionUserIds.map((userId) => get_name(ctx, userId))),
		fileMentions: await shape_file_mentions(ctx, {
			membership: args.membership,
			fileMentionIds: message.fileMentionIds,
		}),
		attachments,
		replyPreview,
		thread: message.threadRootId === null ? await get_thread(ctx, message._id) : null,
	};
}

const agent_args = {
	userId: v.id("users"),
	membershipId: v.id("organizations_workspaces_users"),
	agentSource: ai_chat_workspaces_source_validator,
};

const agent_reference_validator = v.union(
	v.object({ kind: v.literal("channel"), value: v.string() }),
	v.object({ kind: v.literal("public"), value: v.string() }),
	v.object({ kind: v.literal("file_id"), value: v.string() }),
	v.object({ kind: v.literal("file_path"), value: v.string() }),
);

async function get_agent_context(
	ctx: QueryCtx,
	args: {
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
		agentSource: Infer<typeof ai_chat_workspaces_source_validator>;
	},
) {
	const membership = await organizations_db_get_membership(ctx, args);
	if (!membership) return Result({ _nay: { message: "Not found" } });
	const source = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
		...membership,
		agentSource: args.agentSource,
	});
	if (source._nay) return source;
	return Result({ _yay: { membership, userAuth: { id: args.userId } } });
}

async function get_agent_channel(
	ctx: QueryCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		userAuth: { id: Id<"users"> };
		reference: Infer<typeof agent_reference_validator>;
	},
) {
	const { membership, reference } = args;
	let channel: Doc<"channels"> | null = null;
	if (reference.kind === "channel") {
		const id = ctx.db.normalizeId("channels", reference.value);
		channel = id ? await ctx.db.get("channels", id) : null;
	} else if (reference.kind === "public") {
		channel = await ctx.db
			.query("channels")
			.withIndex("by_organization_workspace_kind_name", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("kind", "public")
					.eq("name", reference.value),
			)
			.unique();
	} else {
		const nodeId = reference.kind === "file_id" ? ctx.db.normalizeId("files_nodes", reference.value) : null;
		const node =
			reference.kind === "file_path"
				? await files_db_get_visible_node_by_path(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						path: reference.value,
					})
				: nodeId
					? await ctx.db.get("files_nodes", nodeId)
					: null;
		if (node?.kind === "file")
			channel = await ctx.db
				.query("channels")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("fileNodeId", node._id),
				)
				.unique();
	}
	if (!channel) return Result({ _nay: { message: "Not found" } });
	const access = await channels_db_get_access(ctx, { ...args, channel });
	return access._nay ? access : Result({ _yay: { channel, access: access._yay } });
}

export const agent_list = internalQuery({
	args: {
		...agent_args,
		kind: v.optional(v.union(v.literal("public"), v.literal("private"), v.literal("direct"), v.literal("file"))),
		paginationOpts: paginationOptsValidator,
	},
	returns: v_result({
		_yay: paginationResultValidator(
			v.object({
				channelId: v.id("channels"),
				reference: v.string(),
				kind: v.string(),
				name: v.string(),
				filePath: v.union(v.string(), v.null()),
				lastMessageAt: v.number(),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const context = await get_agent_context(ctx, args);
		if (context._nay) return context;
		const { membership } = context._yay;
		const rows = await ctx.db
			.query("channels")
			.withIndex("by_organization_workspace_kind_name", (q) => {
				const scope = q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId);
				return args.kind ? scope.eq("kind", args.kind) : scope;
			})
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(50, args.paginationOpts.numItems),
				maximumRowsRead: 50,
			});
		const page = [];
		for (const channel of rows.page) {
			const access = await channels_db_get_access(ctx, {
				...context._yay,
				channel,
			});
			if (access._nay) continue;
			let name: string;
			if (channel.kind === "direct") {
				const names = [];
				for (const userId of channel.participantUserIds) {
					const participant = await ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_workspace_user_active", (q) =>
							q.eq("workspaceId", membership.workspaceId).eq("userId", userId).eq("active", true),
						)
						.unique();
					names.push(`${await get_name(ctx, userId)}${participant ? "" : " (left)"}`);
				}
				name = names.join(", ");
			} else name = channel.kind === "file" ? access._yay.fileNode!.name : channel.name;
			const activity = await ctx.db
				.query("channels_activity")
				.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
				.unique();
			page.push({
				channelId: channel._id,
				kind: channel.kind,
				name,
				reference: channel.kind === "public" ? `#${channel.name}` : channel._id,
				filePath: access._yay.fileNode?.path ?? null,
				lastMessageAt: activity!.lastMessageAt,
			});
		}
		return Result({ _yay: { ...rows, page } });
	},
});

export const agent_members = internalQuery({
	args: {
		...agent_args,
		reference: agent_reference_validator,
		paginationOpts: paginationOptsValidator,
	},
	returns: v_result({
		_yay: paginationResultValidator(v.object({ userId: v.id("users"), name: v.string() })),
	}),
	handler: async (ctx, args) => {
		const context = await get_agent_context(ctx, args);
		if (context._nay) return context;
		const target = await get_agent_channel(ctx, {
			...context._yay,
			reference: args.reference,
		});
		if (target._nay) return target;
		const rows = await ctx.db
			.query("channels_members")
			.withIndex("by_channel_user", (q) => q.eq("channelId", target._yay.channel._id))
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(50, args.paginationOpts.numItems),
				maximumRowsRead: 50,
			});
		const page = [];
		for (const member of rows.page) {
			const membership = await ctx.db.get("organizations_workspaces_users", member.workspaceMembershipId);
			if (!membership?.active || membership.userId !== member.userId) continue;
			const read = await channels_db_get_access(ctx, {
				channel: target._yay.channel,
				membership,
				userAuth: { id: member.userId },
			});
			if (!read._nay && read._yay.member?._id === member._id)
				page.push({
					userId: member.userId,
					name: await get_name(ctx, member.userId),
				});
		}
		return Result({ _yay: { ...rows, page } });
	},
});

export const agent_read = internalQuery({
	args: {
		...agent_args,
		reference: agent_reference_validator,
		since: v.optional(v.number()),
		until: v.optional(v.number()),
		rootMessageId: v.optional(v.string()),
		paginationOpts: paginationOptsValidator,
	},
	returns: v_result({
		_yay: paginationResultValidator(shaped_message_validator),
	}),
	handler: async (ctx, args) => {
		const context = await get_agent_context(ctx, args);
		if (context._nay) return context;
		const target = await get_agent_channel(ctx, {
			...context._yay,
			reference: args.reference,
		});
		if (target._nay) return target;
		const channelId = target._yay.channel._id;
		const rootMessageId = args.rootMessageId ? ctx.db.normalizeId("channels_messages", args.rootMessageId) : null;
		let rootMessage: Doc<"channels_messages"> | null = null;
		if (args.rootMessageId) {
			const root = rootMessageId
				? await get_message_context(ctx, {
						...context._yay,
						messageId: rootMessageId,
					})
				: null;
			if (!root || root._nay || root._yay.channel._id !== channelId || root._yay.message.threadRootId !== null)
				return Result({ _nay: { message: "Not found" } });
			rootMessage = root._yay.message;
		}
		const since = args.since ?? 0;
		const until = args.until ?? Number.MAX_SAFE_INTEGER;
		// A thread reads only its own replies. The root is not a reply, so the first page adds it in front.
		// It is older than every reply, so time order stays right.
		const query = rootMessageId
			? ctx.db
					.query("channels_messages")
					.withIndex("by_threadRoot", (q) =>
						q.eq("threadRootId", rootMessageId).gte("_creationTime", since).lt("_creationTime", until),
					)
			: ctx.db
					.query("channels_messages")
					.withIndex("by_channel", (q) =>
						q.eq("channelId", channelId).gte("_creationTime", since).lt("_creationTime", until),
					);
		const rootInPage =
			rootMessage !== null &&
			args.paginationOpts.cursor === null &&
			rootMessage._creationTime >= since &&
			rootMessage._creationTime < until;
		const rows = await query.paginate({
			...args.paginationOpts,
			numItems: Math.max(1, Math.min(50, args.paginationOpts.numItems) - (rootInPage ? 1 : 0)),
			maximumBytesRead: channels_LIMITS.pageBytes,
		});
		const messages = rootInPage && rootMessage ? [rootMessage, ...rows.page] : rows.page;
		const shaped = await Promise.all(messages.map((message) => shape_message(ctx, { ...context._yay, message })));
		return Result({
			_yay: { ...rows, page: shaped.filter((row) => row !== null) },
		});
	},
});

const search_args = {
	query: v.string(),
	authorUserId: v.optional(v.string()),
	hasAttachments: v.optional(v.boolean()),
	since: v.optional(v.number()),
	until: v.optional(v.number()),
	paginationOpts: paginationOptsValidator,
};

async function search_page(
	ctx: QueryCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		userAuth: { id: Id<"users"> };
		query: string;
		channelId?: string;
		authorUserId?: string;
		hasAttachments?: boolean;
		since?: number;
		until?: number;
		paginationOpts: PaginationOptions;
	},
) {
	const parsed = channels_search_query_schema.safeParse(args.query);
	if (!parsed.success) return Result({ _nay: { message: parsed.error.issues[0]!.message } });
	if (
		[args.since, args.until].some((date) => date !== undefined && (!Number.isSafeInteger(date) || date < 0)) ||
		(args.since !== undefined && args.until !== undefined && args.since >= args.until)
	)
		return Result({ _nay: { message: "Use valid dates, with Since before Until" } });
	const channelId = args.channelId ? ctx.db.normalizeId("channels", args.channelId) : null;
	const authorUserId = args.authorUserId ? ctx.db.normalizeId("users", args.authorUserId) : null;
	if ((args.channelId !== undefined && !channelId) || (args.authorUserId !== undefined && !authorUserId))
		return Result({ _nay: { message: "Not found" } });
	if (channelId) {
		const channel = await ctx.db.get("channels", channelId);
		if (!channel) return Result({ _nay: { message: "Not found" } });
		const access = await channels_db_get_access(ctx, { ...args, channel });
		if (access._nay) return access;
	}
	const { membership } = args;
	const docs = await ctx.db
		.query("channels_messages")
		.withSearchIndex("search_body", (q) => {
			let search = q
				.search("body", parsed.data)
				.eq("organizationId", membership.organizationId)
				.eq("workspaceId", membership.workspaceId);
			if (channelId) search = search.eq("channelId", channelId);
			if (authorUserId) search = search.eq("authorUserId", authorUserId);
			if (args.hasAttachments !== undefined) search = search.eq("hasAttachments", args.hasAttachments);
			return search;
		})
		.filter((q) =>
			q.and(
				q.gte(q.field("_creationTime"), args.since ?? 0),
				q.lt(q.field("_creationTime"), args.until ?? Number.MAX_SAFE_INTEGER),
			),
		)
		// Search ignores maximumRowsRead and maximumBytesRead. This caps returned candidates.
		.paginate({ ...args.paginationOpts, numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems) });
	const page = [];
	for (const message of docs.page) {
		if (message.deletedAt !== null) continue;
		const access = await get_message_context(ctx, { ...args, messageId: message._id });
		if (access._nay) continue;
		const shaped = await shape_message(ctx, { ...args, message });
		if (shaped) page.push(shaped);
	}
	return Result({ _yay: { ...docs, page } });
}

export const agent_search = internalQuery({
	args: { ...agent_args, ...search_args, reference: v.optional(agent_reference_validator) },
	returns: v_result({ _yay: paginationResultValidator(shaped_message_validator) }),
	handler: async (ctx, args) => {
		const context = await get_agent_context(ctx, args);
		if (context._nay) return context;
		let channelId: Id<"channels"> | undefined;
		if (args.reference) {
			const target = await get_agent_channel(ctx, { ...context._yay, reference: args.reference });
			if (target._nay) return target;
			channelId = target._yay.channel._id;
		}
		return search_page(ctx, { ...args, ...context._yay, channelId });
	},
});

export const search_messages = query({
	args: { membershipId: v.id("organizations_workspaces_users"), ...search_args, channelId: v.optional(v.string()) },
	returns: paginationResultValidator(shaped_message_validator),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const result = await search_page(ctx, { ...args, ...context._yay });
		return result._nay ? { page: [], isDone: true, continueCursor: "" } : result._yay;
	},
});

export const get_attachable_files = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeIds: v.array(v.id("files_nodes")),
	},
	returns: v.array(v.id("files_nodes")),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return [];
		}
		if (args.fileNodeIds.length > channels_LIMITS.page) return [];
		const ready: Id<"files_nodes">[] = [];
		for (const fileNodeId of args.fileNodeIds) {
			const read = await access_control_db_authorize_node(ctx, {
				...context._yay,
				nodeId: fileNodeId,
				permission: "content.read",
			});
			if (read._nay || read._yay.fileNode.kind !== "file" || read._yay.fileNode.archiveOperationId !== null) continue;
			const asset = read._yay.fileNode.assetId ? await ctx.db.get("files_r2_assets", read._yay.fileNode.assetId) : null;
			if (asset?.kind === "upload" && !asset.r2Key) continue;
			ready.push(fileNodeId);
		}
		return ready;
	},
});

export const get_message = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		messageId: v.string(),
	},
	returns: v.union(shaped_message_validator, v.null()),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return null;
		}
		const messageId = ctx.db.normalizeId("channels_messages", args.messageId);
		if (!messageId) return null;
		const target = await get_message_context(ctx, {
			...context._yay,
			messageId,
		});
		return target._nay ? null : shape_message(ctx, { ...context._yay, message: target._yay.message });
	},
});

export const list_latest_main = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		channelId: v.id("channels"),
	},
	returns: v.object({
		messages: v.array(shaped_message_validator),
		lastMainSequence: v.number(),
	}),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { messages: [], lastMainSequence: 0 };
		}
		const channel = await ctx.db.get("channels", args.channelId);
		if (!channel) return { messages: [], lastMainSequence: 0 };
		const access = await channels_db_get_access(ctx, {
			...context._yay,
			channel,
		});
		if (access._nay) return { messages: [], lastMainSequence: 0 };
		const activity = (await ctx.db
			.query("channels_activity")
			.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
			.unique())!;
		const rows = await ctx.db
			.query("channels_messages")
			.withIndex("by_channel_mainSequence", (q) => q.eq("channelId", channel._id).gt("mainSequence", null))
			.order("desc")
			.take(channels_LIMITS.page);
		const shaped = await Promise.all(rows.map((message) => shape_message(ctx, { ...context._yay, message })));
		return {
			messages: shaped.filter((item) => item !== null),
			lastMainSequence: activity.lastMainSequence,
		};
	},
});

export const list_main_page = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		channelId: v.id("channels"),
		anchorSequence: v.number(),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(shaped_message_validator),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const channel = await ctx.db.get("channels", args.channelId);
		if (!channel) return { page: [], isDone: true, continueCursor: "" };
		const access = await channels_db_get_access(ctx, {
			...context._yay,
			channel,
		});
		if (access._nay) return { page: [], isDone: true, continueCursor: "" };
		const rows = await ctx.db
			.query("channels_messages")
			.withIndex("by_channel_mainSequence", (q) =>
				q.eq("channelId", channel._id).gt("mainSequence", null).lt("mainSequence", args.anchorSequence),
			)
			.order("desc")
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems),
				maximumRowsRead: channels_LIMITS.page,
				maximumBytesRead: channels_LIMITS.pageBytes,
			});
		const shaped = await Promise.all(rows.page.map((message) => shape_message(ctx, { ...context._yay, message })));
		return { ...rows, page: shaped.filter((item) => item !== null) };
	},
});

export const get_thread_by_root = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.string(),
	},
	returns: v.union(
		v.null(),
		v.object({
			thread: v.union(doc(app_convex_schema, "channels_threads"), v.null()),
			root: shaped_message_validator,
		}),
	),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return null;
		}
		const rootMessageId = ctx.db.normalizeId("channels_messages", args.rootMessageId);
		if (!rootMessageId) return null;
		const target = await get_message_context(ctx, {
			...context._yay,
			messageId: rootMessageId,
		});
		if (target._nay || target._yay.message.threadRootId !== null) return null;
		const root = await shape_message(ctx, {
			...context._yay,
			message: target._yay.message,
		});
		return root ? { root, thread: target._yay.thread } : null;
	},
});

export const list_latest_thread = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
	},
	returns: v.object({
		messages: v.array(shaped_message_validator),
		lastReplySequence: v.number(),
	}),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { messages: [], lastReplySequence: 0 };
		}
		const target = await get_message_context(ctx, {
			...context._yay,
			messageId: args.rootMessageId,
		});
		if (target._nay || target._yay.message.threadRootId !== null) return { messages: [], lastReplySequence: 0 };
		const rows = await ctx.db
			.query("channels_messages")
			.withIndex("by_threadRoot_threadSequence", (q) => q.eq("threadRootId", args.rootMessageId))
			.order("desc")
			.take(channels_LIMITS.page);
		const shaped = await Promise.all(rows.map((message) => shape_message(ctx, { ...context._yay, message })));
		return {
			messages: shaped.filter((item) => item !== null),
			lastReplySequence: target._yay.thread?.lastReplySequence ?? 0,
		};
	},
});

export const get_thread_state = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
	},
	returns: v.union(
		v.null(),
		v.object({
			follower: v.union(doc(app_convex_schema, "channels_thread_followers"), v.null()),
			unreadCount: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return null;
		}
		const target = await get_message_context(ctx, {
			...context._yay,
			messageId: args.rootMessageId,
		});
		if (target._nay || target._yay.message.threadRootId !== null) return null;
		const { thread, channel, access } = target._yay;
		const follower = thread
			? await ctx.db
					.query("channels_thread_followers")
					.withIndex("by_thread_user", (q) => q.eq("threadId", thread._id).eq("userId", context._yay.userAuth.id))
					.unique()
			: null;
		return {
			follower,
			unreadCount:
				(channel.kind === "private" || channel.kind === "direct") && !access.member
					? 0
					: Math.max(0, (thread?.lastReplySequence ?? 0) - (follower?.readReplySequence ?? 0)),
		};
	},
});

export const list_thread_page = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
		anchorSequence: v.number(),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(shaped_message_validator),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const target = await get_message_context(ctx, {
			...context._yay,
			messageId: args.rootMessageId,
		});
		if (target._nay || target._yay.message.threadRootId !== null) return { page: [], isDone: true, continueCursor: "" };
		const rows = await ctx.db
			.query("channels_messages")
			.withIndex("by_threadRoot_threadSequence", (q) =>
				q.eq("threadRootId", args.rootMessageId).lt("threadSequence", args.anchorSequence),
			)
			.order("desc")
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems),
				maximumRowsRead: channels_LIMITS.page,
				maximumBytesRead: channels_LIMITS.pageBytes,
			});
		const shaped = await Promise.all(rows.page.map((message) => shape_message(ctx, { ...context._yay, message })));
		return { ...rows, page: shaped.filter((item) => item !== null) };
	},
});

export const get_mentionable_users = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		target: v.union(v.object({ channelId: v.id("channels") }), v.object({ fileNodeId: v.id("files_nodes") })),
		userIds: v.array(v.id("users")),
	},
	returns: v.array(v.id("users")),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return [];
		}
		if (args.userIds.length > channels_LIMITS.page) return [];
		const channel = "channelId" in args.target ? await ctx.db.get("channels", args.target.channelId) : null;
		const fileNodeId =
			"fileNodeId" in args.target ? args.target.fileNodeId : channel?.kind === "file" ? channel.fileNodeId : null;
		if ("channelId" in args.target) {
			if (!channel || (await channels_db_get_access(ctx, { ...context._yay, channel }))._nay) return [];
		} else {
			const read = await access_control_db_authorize_node(ctx, {
				...context._yay,
				nodeId: args.target.fileNodeId,
				permission: "content.read",
			});
			if (read._nay || read._yay.fileNode.kind !== "file") return [];
		}
		const userIds: Id<"users">[] = [];
		for (const userId of new Set(args.userIds)) {
			if (await can_mention(ctx, { membership: context._yay.membership, channel, fileNodeId, userId }))
				userIds.push(userId);
		}
		return userIds;
	},
});

export const list_posts = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		channelId: v.id("channels"),
		filter: v.union(v.literal("open"), v.literal("resolved"), v.literal("all")),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(shaped_message_validator),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const channel = await ctx.db.get("channels", args.channelId);
		if (!channel) return { page: [], isDone: true, continueCursor: "" };
		const access = await channels_db_get_access(ctx, {
			...context._yay,
			channel,
		});
		if (access._nay || !is_posts(channel)) return { page: [], isDone: true, continueCursor: "" };
		const threads = await (
			args.filter === "all"
				? ctx.db.query("channels_threads").withIndex("by_channel_lastActivityAt", (q) => q.eq("channelId", channel._id))
				: ctx.db
						.query("channels_threads")
						.withIndex("by_channel_isResolved_lastActivityAt", (q) =>
							q.eq("channelId", channel._id).eq("isResolved", args.filter === "resolved"),
						)
		)
			.order("desc")
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems),
				maximumRowsRead: channels_LIMITS.page,
				maximumBytesRead: channels_LIMITS.pageBytes,
			});
		const page: NonNullable<Awaited<ReturnType<typeof shape_message>>>[] = [];
		for (const thread of threads.page) {
			const message = await ctx.db.get("channels_messages", thread.rootMessageId);
			if (!message) continue;
			const shaped = await shape_message(ctx, { ...context._yay, message });
			if (shaped) page.push(shaped);
		}
		return { ...threads, page };
	},
});

export const list_my_threads = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			follower: doc(app_convex_schema, "channels_thread_followers"),
			root: shaped_message_validator,
			unread: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const { membership, userAuth } = context._yay;
		const rows = await ctx.db
			.query("channels_thread_followers")
			.withIndex("by_organization_workspace_user_following_threadLastActivityAt", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", userAuth.id)
					.eq("following", true),
			)
			.order("desc")
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems),
				maximumRowsRead: channels_LIMITS.page,
				maximumBytesRead: channels_LIMITS.pageBytes,
			});
		const page = [];
		for (const follower of rows.page) {
			const target = await get_message_context(ctx, {
				...context._yay,
				messageId: follower.rootMessageId,
			});
			if (target._nay) continue;
			const root = await shape_message(ctx, {
				...context._yay,
				message: target._yay.message,
			});
			if (!root?.thread) continue;
			page.push({
				follower,
				root,
				unread: follower.pendingRootMention || root.thread.lastReplySequence > follower.readReplySequence,
			});
		}
		return { ...rows, page };
	},
});

export const list_my_inbox = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			item: doc(app_convex_schema, "channels_inbox"),
			message: shaped_message_validator,
			unread: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const { membership, userAuth } = context._yay;
		const rows = await ctx.db
			.query("channels_inbox")
			.withIndex("by_recipient_organization_workspace_createdAt", (q) =>
				q
					.eq("recipientUserId", userAuth.id)
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId),
			)
			.order("desc")
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems),
				maximumRowsRead: channels_LIMITS.page,
				maximumBytesRead: channels_LIMITS.pageBytes,
			});
		const page = [];
		for (const item of rows.page) {
			const target = await get_message_context(ctx, {
				...context._yay,
				messageId: item.messageId,
			});
			if (target._nay || target._yay.message.deletedAt !== null) continue;
			const message = await shape_message(ctx, {
				...context._yay,
				message: target._yay.message,
			});
			if (!message) continue;
			const read = await ctx.db
				.query("channels_read_states")
				.withIndex("by_channel_user", (q) => q.eq("channelId", item.channelId).eq("userId", userAuth.id))
				.unique();
			const follower = target._yay.thread
				? await ctx.db
						.query("channels_thread_followers")
						.withIndex("by_thread_user", (q) => q.eq("threadId", target._yay.thread!._id).eq("userId", userAuth.id))
						.unique()
				: null;
			const mainUnread = item.mainSequence !== null && item.mainSequence > (read?.readSequence ?? 0);
			const threadUnread =
				item.threadSequence === 0
					? (follower?.pendingRootMention ?? false)
					: item.threadSequence !== null && item.threadSequence > (follower?.readReplySequence ?? 0);
			// A broadcast clears when either its channel or its thread is read.
			const unread =
				item.threadSequence === 0
					? threadUnread
					: item.threadSequence === null
						? mainUnread
						: item.mainSequence === null
							? threadUnread
							: mainUnread && threadUnread;
			page.push({ item, message, unread });
		}
		return { ...rows, page };
	},
});

export const confirm_comment_anchor = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) return context;
		const target = await get_message_context(ctx, {
			...context._yay,
			messageId: args.rootMessageId,
		});
		if (target._nay) return target;
		const { message, channel, thread, access } = target._yay;
		if (
			channel.kind !== "file" ||
			message.threadRootId !== null ||
			message.authorUserId !== context._yay.userAuth.id ||
			!thread?.anchor
		)
			return Result({ _nay: { message: "Not found" } });
		if (!access.canPost) return Result({ _nay: { message: access.postRefusal! } });
		if (thread.anchor.confirmedAt !== null) return Result({ _yay: null });
		const activity = (await ctx.db
			.query("channels_activity")
			.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
			.unique())!;
		const read = await ctx.db
			.query("channels_read_states")
			.withIndex("by_channel_user", (q) => q.eq("channelId", channel._id).eq("userId", message.authorUserId))
			.unique();
		const channelSequence = activity.lastChannelSequence + 1;
		const mainSequence = activity.lastMainSequence + 1;
		const confirmedAt = Date.now();
		const mentions: Id<"users">[] = [];
		for (const userId of message.mentionUserIds) {
			if (
				await can_mention(ctx, {
					membership: context._yay.membership,
					channel,
					fileNodeId: channel.fileNodeId,
					userId,
				})
			)
				mentions.push(userId);
		}
		// Dropping a mention must not point its body token at the next person.
		const body = message.body.replace(/\[@ id="user:(\d+)"\]/g, (_token, index: string) => {
			const userId = message.mentionUserIds[Number(index)];
			const nextIndex = userId ? mentions.indexOf(userId) : -1;
			return nextIndex < 0 ? "@Person" : `[@ id="user:${nextIndex}"]`;
		});
		await ctx.db.patch("channels_activity", activity._id, {
			lastChannelSequence: channelSequence,
			lastMainSequence: mainSequence,
			lastMessageAt: confirmedAt,
		});
		await ctx.db.patch("channels_threads", thread._id, {
			anchor: { ...thread.anchor, confirmedAt },
			lastActivitySequence: channelSequence,
			lastActivityAt: confirmedAt,
		});
		await ctx.db.patch("channels_messages", message._id, {
			channelSequence,
			mainSequence,
			mentionUserIds: mentions,
			body,
		});
		const confirmedThread = (await ctx.db.get("channels_threads", thread._id))!;
		await follow(ctx, {
			thread: confirmedThread,
			userId: message.authorUserId,
			readReplySequence: 0,
			markRead: true,
		});
		await channels_db_add_member(ctx, {
			channel,
			membership: context._yay.membership,
			level: "member",
			addedBy: null,
		});
		await notify(ctx, {
			message: { ...message, channelSequence, mainSequence, mentionUserIds: mentions, body },
			channel,
			thread: confirmedThread,
			replyAuthorUserId: null,
		});
		if ((read?.readSequence ?? 0) === activity.lastChannelSequence)
			await channels_db_mark_read(ctx, { channel, userId: message.authorUserId, sequence: channelSequence });
		return Result({ _yay: null });
	},
});

async function delete_thread_state(ctx: MutationCtx, thread: Doc<"channels_threads">) {
	await ctx.db.delete("channels_threads", thread._id);
	const followers = await ctx.db
		.query("channels_thread_followers")
		.withIndex("by_thread", (q) => q.eq("threadId", thread._id))
		.take(100);
	await Promise.all(followers.map((item) => ctx.db.delete("channels_thread_followers", item._id)));
	if (followers.length === 100)
		await ctx.scheduler.runAfter(0, internal.channels_messages.delete_thread_followers, { threadId: thread._id });
}

export const delete_thread_followers = internalMutation({
	args: { threadId: v.id("channels_threads") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const followers = await ctx.db
			.query("channels_thread_followers")
			.withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
			.take(100);
		await Promise.all(followers.map((item) => ctx.db.delete("channels_thread_followers", item._id)));
		if (followers.length === 100)
			await ctx.scheduler.runAfter(0, internal.channels_messages.delete_thread_followers, args);
		return null;
	},
});

async function release_uploads(ctx: MutationCtx, message: Doc<"channels_messages">) {
	for (const attachment of message.attachments) {
		if (attachment.kind !== "upload") continue;
		const upload = await ctx.db.get("channels_uploads", attachment.uploadId);
		if (upload?.messageId !== message._id) continue;
		// Workspace purge may have removed the asset before its messages drain.
		const asset = await ctx.db.get("files_r2_assets", upload.assetId);
		if (asset) await ctx.db.patch("files_r2_assets", asset._id, { unfinalizedExpiresAt: Date.now() });
	}
}

export const discard_unconfirmed_comment = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) return context;
		const target = await get_message_context(ctx, {
			...context._yay,
			messageId: args.rootMessageId,
		});
		if (target._nay) return target;
		const { message, thread } = target._yay;
		if (
			message.authorUserId !== context._yay.userAuth.id ||
			message.threadRootId !== null ||
			thread?.anchor?.confirmedAt !== null ||
			thread.replyCount !== 0
		)
			return Result({ _nay: { message: "This comment cannot be discarded" } });
		await release_uploads(ctx, message);
		await delete_thread_state(ctx, thread);
		await ctx.db.delete("channels_messages", message._id);
		return Result({ _yay: null });
	},
});

export const delete_unconfirmed_comments = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const threads = await ctx.db
			.query("channels_threads")
			.withIndex("by_anchor_confirmedAt", (q) => q.eq("anchor.confirmedAt", null))
			.filter((q) => q.lt(q.field("_creationTime"), Date.now() - 60 * 60 * 1000))
			.take(50);
		for (const thread of threads) {
			if (thread.replyCount !== 0) continue;
			const message = (await ctx.db.get("channels_messages", thread.rootMessageId))!;
			await release_uploads(ctx, message);
			await delete_thread_state(ctx, thread);
			await ctx.db.delete("channels_messages", thread.rootMessageId);
		}
		if (threads.length === 50)
			await ctx.scheduler.runAfter(0, internal.channels_messages.delete_unconfirmed_comments, {});
		return null;
	},
});

export const edit_message = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		messageId: v.id("channels_messages"),
		expectedRevision: v.number(),
		body: v.string(),
		mentionUserIds: v.array(v.id("users")),
		fileMentionIds: v.array(v.id("files_nodes")),
		fileQuotes: v.array(file_quote_validator),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_message_write_context(ctx, args, "channels_message_write");
		if (context._nay) return context;
		const { message, userAuth, membership, channel } = context._yay;
		if (message.authorUserId !== userAuth.id || message.deletedAt !== null)
			return Result({
				_nay: { message: "Only the author can edit this message" },
			});
		if (message.revision !== args.expectedRevision)
			return Result({ _nay: { message: "Message changed. Open it again" } });
		if (files_get_utf8_byte_size(args.body) > channels_LIMITS.bodyBytes)
			return Result({ _nay: { message: "Message is too long" } });
		if (!args.body.trim() && !message.hasAttachments)
			return Result({ _nay: { message: "Write a message or add a file" } });
		const mentions = await validate_mentions(ctx, {
			membership,
			channel,
			fileNodeId: null,
			mentionUserIds: args.mentionUserIds,
		});
		if (mentions._nay) return mentions;
		const fileReferences = await validate_file_references(ctx, { ...args, membership });
		if (fileReferences._nay) return fileReferences;
		const removed = message.mentionUserIds.filter((id) => !mentions._yay.includes(id));
		const items = await ctx.db
			.query("channels_inbox")
			.withIndex("by_message", (q) => q.eq("messageId", message._id))
			.take(channels_LIMITS.mentions + 1);
		await ctx.db.patch("channels_messages", message._id, {
			body: args.body,
			mentionUserIds: mentions._yay,
			fileMentionIds: args.fileMentionIds,
			fileQuotes: fileReferences._yay,
			revision: message.revision + 1,
			editedAt: Date.now(),
		});
		for (const item of items)
			if (item.kind === "mention" && removed.includes(item.recipientUserId))
				await ctx.db.delete("channels_inbox", item._id);
		if (is_posts(channel) && message.threadRootId === null && context._yay.thread) {
			for (const userId of removed) {
				const follower = await ctx.db
					.query("channels_thread_followers")
					.withIndex("by_thread_user", (q) => q.eq("threadId", context._yay.thread!._id).eq("userId", userId))
					.unique();
				if (follower)
					await ctx.db.patch("channels_thread_followers", follower._id, {
						pendingRootMention: false,
					});
			}
		}
		return Result({ _yay: null });
	},
});

export const delete_message = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		messageId: v.id("channels_messages"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_message_write_context(ctx, args, "channels_message_write");
		if (context._nay) return context;
		const { message, userAuth, access, thread } = context._yay;
		if (message.authorUserId !== userAuth.id && !access.canManage)
			return Result({ _nay: { message: "Permission denied" } });
		if (message.deletedAt !== null) return Result({ _yay: null });
		const counts = await ctx.db
			.query("channels_reaction_counts")
			.withIndex("by_message_emoji", (q) => q.eq("messageId", message._id))
			.take(channels_LIMITS.emoji);
		const inbox = await ctx.db
			.query("channels_inbox")
			.withIndex("by_message", (q) => q.eq("messageId", message._id))
			.take(channels_LIMITS.mentions + 1);
		await release_uploads(ctx, message);
		await ctx.db.patch("channels_messages", message._id, {
			body: "",
			mentionUserIds: [],
			fileMentionIds: [],
			fileQuotes: [],
			attachments: [],
			hasAttachments: false,
			replyTo: null,
			deletedAt: Date.now(),
			revision: message.revision + 1,
		});
		await Promise.all(counts.map((count) => ctx.db.delete("channels_reaction_counts", count._id)));
		await Promise.all(inbox.map((item) => ctx.db.delete("channels_inbox", item._id)));
		await ctx.scheduler.runAfter(0, internal.channels_messages.delete_message_reactions, { messageId: message._id });
		if (thread) {
			if (message.threadRootId !== null)
				await ctx.db.patch("channels_threads", thread._id, {
					replyCount: thread.replyCount - 1,
				});
			else {
				for (const userId of message.mentionUserIds) {
					const follower = await ctx.db
						.query("channels_thread_followers")
						.withIndex("by_thread_user", (q) => q.eq("threadId", thread._id).eq("userId", userId))
						.unique();
					if (follower?.pendingRootMention)
						await ctx.db.patch("channels_thread_followers", follower._id, {
							pendingRootMention: false,
						});
				}
				if (thread.replyCount === 0) await delete_thread_state(ctx, thread);
			}
			if (message.threadRootId !== null && thread.replyCount === 1) {
				const root = await ctx.db.get("channels_messages", thread.rootMessageId);
				if (root?.deletedAt !== null) await delete_thread_state(ctx, thread);
			}
		}
		return Result({ _yay: null });
	},
});

export const delete_message_reactions = internalMutation({
	args: { messageId: v.id("channels_messages") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const reactions = await ctx.db
			.query("channels_reactions")
			.withIndex("by_message", (q) => q.eq("messageId", args.messageId))
			.take(100);
		await Promise.all(reactions.map((reaction) => ctx.db.delete("channels_reactions", reaction._id)));
		if (reactions.length === 100)
			await ctx.scheduler.runAfter(0, internal.channels_messages.delete_message_reactions, args);
		return null;
	},
});

export const toggle_reaction = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		messageId: v.id("channels_messages"),
		emoji: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_message_write_context(ctx, args, "channels_reaction_write");
		if (context._nay) return context;
		const { message, userAuth } = context._yay;
		if (message.deletedAt !== null) return Result({ _nay: { message: "Message was deleted" } });
		if (!channels_is_emoji(args.emoji)) return Result({ _nay: { message: "Choose one emoji" } });
		const reaction = await ctx.db
			.query("channels_reactions")
			.withIndex("by_message_emoji_user", (q) =>
				q.eq("messageId", message._id).eq("emoji", args.emoji).eq("userId", userAuth.id),
			)
			.unique();
		const counts = await ctx.db
			.query("channels_reaction_counts")
			.withIndex("by_message_emoji", (q) => q.eq("messageId", message._id))
			.take(channels_LIMITS.emoji);
		const count = counts.find((item) => item.emoji === args.emoji);
		if (!reaction && !count && counts.length >= channels_LIMITS.emoji)
			return Result({
				_nay: { message: "This message has 20 different reactions" },
			});
		if (reaction) {
			await ctx.db.delete("channels_reactions", reaction._id);
			if (count!.count === 1) await ctx.db.delete("channels_reaction_counts", count!._id);
			else
				await ctx.db.patch("channels_reaction_counts", count!._id, {
					count: count!.count - 1,
				});
		} else {
			await ctx.db.insert("channels_reactions", {
				messageId: message._id,
				channelId: message.channelId,
				organizationId: message.organizationId,
				workspaceId: message.workspaceId,
				userId: userAuth.id,
				emoji: args.emoji,
			});
			if (count)
				await ctx.db.patch("channels_reaction_counts", count._id, {
					count: count.count + 1,
				});
			else
				await ctx.db.insert("channels_reaction_counts", {
					messageId: message._id,
					organizationId: message.organizationId,
					workspaceId: message.workspaceId,
					emoji: args.emoji,
					count: 1,
				});
		}
		return Result({ _yay: null });
	},
});

export const list_message_reactions = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		messageId: v.id("channels_messages"),
	},
	returns: v.array(
		v.object({
			emoji: v.string(),
			count: v.number(),
			mine: v.boolean(),
			names: v.array(v.string()),
		}),
	),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return [];
		}
		const target = await get_message_context(ctx, {
			...context._yay,
			messageId: args.messageId,
		});
		if (target._nay || target._yay.message.deletedAt !== null) return [];
		const counts = await ctx.db
			.query("channels_reaction_counts")
			.withIndex("by_message_emoji", (q) => q.eq("messageId", args.messageId))
			.take(channels_LIMITS.emoji);
		return Promise.all(
			counts.map(async (count) => {
				const mine = await ctx.db
					.query("channels_reactions")
					.withIndex("by_message_emoji_user", (q) =>
						q.eq("messageId", args.messageId).eq("emoji", count.emoji).eq("userId", context._yay.userAuth.id),
					)
					.unique();
				const reactions = await ctx.db
					.query("channels_reactions")
					.withIndex("by_message_emoji_user", (q) => q.eq("messageId", args.messageId).eq("emoji", count.emoji))
					.take(10);
				return {
					emoji: count.emoji,
					count: count.count,
					mine: !!mine,
					names: await Promise.all(reactions.map((item) => get_name(ctx, item.userId))),
				};
			}),
		);
	},
});

async function change_resolution(
	ctx: MutationCtx,
	args: {
		membershipId: Id<"organizations_workspaces_users">;
		rootMessageId: Id<"channels_messages">;
	},
	isResolved: boolean,
) {
	const context = await get_message_write_context(
		ctx,
		{ membershipId: args.membershipId, messageId: args.rootMessageId },
		"channels_write",
	);
	if (context._nay) return context;
	const { message, channel, userAuth } = context._yay;
	if (
		message.threadRootId !== null ||
		channel.kind === "direct" ||
		((channel.kind === "public" || channel.kind === "private") && !channel.resolvableThreads)
	)
		return Result({ _nay: { message: "This channel does not use resolve" } });
	const thread = await ensure_thread(ctx, message);
	await ctx.db.patch("channels_threads", thread._id, {
		isResolved,
		resolvedAt: isResolved ? Date.now() : null,
		resolvedBy: isResolved ? userAuth.id : null,
	});
	await follow(ctx, {
		thread,
		userId: message.authorUserId,
		readReplySequence: 0,
	});
	return Result({ _yay: null });
}

export const resolve_thread = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => change_resolution(ctx, args, true),
});

export const reopen_thread = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => change_resolution(ctx, args, false),
});

export const set_thread_title = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
		title: v.union(v.string(), v.null()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_message_write_context(
			ctx,
			{ membershipId: args.membershipId, messageId: args.rootMessageId },
			"channels_write",
		);
		if (context._nay) return context;
		const { message, access, userAuth } = context._yay;
		if (message.threadRootId !== null || (message.authorUserId !== userAuth.id && !access.canManage))
			return Result({ _nay: { message: "Permission denied" } });
		if (args.title !== null && args.title.length > channels_LIMITS.title)
			return Result({ _nay: { message: "Title is too long" } });
		const thread = await ensure_thread(ctx, message);
		await ctx.db.patch("channels_threads", thread._id, { title: args.title });
		await follow(ctx, {
			thread,
			userId: message.authorUserId,
			readReplySequence: 0,
		});
		return Result({ _yay: null });
	},
});

async function get_follow_context(
	ctx: MutationCtx,
	args: {
		membershipId: Id<"organizations_workspaces_users">;
		rootMessageId: Id<"channels_messages">;
	},
	rateLimited: boolean,
) {
	const context = await get_context(ctx, args.membershipId);
	if (context._nay) return context;
	if (rateLimited) {
		const limit = await rate_limiter_limit_by_key(ctx, {
			name: "channels_write",
			key: context._yay.userAuth.id,
		});
		if (limit) return Result({ _nay: { message: limit.message } });
	}
	const target = await get_message_context(ctx, {
		...context._yay,
		messageId: args.rootMessageId,
	});
	if (target._nay) return target;
	if (!target._yay.thread || target._yay.message.threadRootId !== null)
		return Result({ _nay: { message: "Not found" } });
	if ((target._yay.channel.kind === "private" || target._yay.channel.kind === "direct") && !target._yay.access.member)
		return Result({ _nay: { message: "Join the channel first" } });
	return Result({
		_yay: { ...context._yay, ...target._yay, thread: target._yay.thread },
	});
}

export const follow_thread = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_follow_context(ctx, args, true);
		if (context._nay) return context;
		await follow(ctx, {
			thread: context._yay.thread,
			userId: context._yay.userAuth.id,
			readReplySequence: context._yay.thread.lastReplySequence,
		});
		return Result({ _yay: null });
	},
});

export const unfollow_thread = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_follow_context(ctx, args, true);
		if (context._nay) return context;
		const follower = await ctx.db
			.query("channels_thread_followers")
			.withIndex("by_thread_user", (q) =>
				q.eq("threadId", context._yay.thread._id).eq("userId", context._yay.userAuth.id),
			)
			.unique();
		if (follower)
			await ctx.db.patch("channels_thread_followers", follower._id, {
				following: false,
			});
		return Result({ _yay: null });
	},
});

export const mark_thread_read = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		rootMessageId: v.id("channels_messages"),
		replySequence: v.number(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_follow_context(ctx, args, false);
		if (context._nay) return context;
		if (!Number.isSafeInteger(args.replySequence) || args.replySequence < 0)
			return Result({ _nay: { message: "Invalid read position" } });
		const { thread, userAuth } = context._yay;
		const follower = await ctx.db
			.query("channels_thread_followers")
			.withIndex("by_thread_user", (q) => q.eq("threadId", thread._id).eq("userId", userAuth.id))
			.unique();
		const readReplySequence = Math.min(args.replySequence, thread.lastReplySequence);
		if (follower)
			await ctx.db.patch("channels_thread_followers", follower._id, {
				readReplySequence: Math.max(follower.readReplySequence, readReplySequence),
				pendingRootMention: false,
			});
		else
			await ctx.db.insert("channels_thread_followers", {
				threadId: thread._id,
				rootMessageId: thread.rootMessageId,
				channelId: thread.channelId,
				organizationId: thread.organizationId,
				workspaceId: thread.workspaceId,
				userId: userAuth.id,
				readReplySequence,
				following: false,
				pendingRootMention: false,
				threadLastActivityAt: thread.lastActivityAt,
				followedAt: Date.now(),
			});
		return Result({ _yay: null });
	},
});
