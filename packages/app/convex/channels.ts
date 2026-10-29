import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { mutation } from "./functions.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import app_convex_schema from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous, string_prefix_upper_bound } from "../server/server-utils.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { access_control_db_authorize_membership, access_control_db_authorize_node } from "./access_control.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { channels_LIMITS, channels_normalize_name } from "../shared/channels.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import {
	channels_notifications_db_ensure_summary,
	channels_notifications_db_apply,
	channels_notifications_db_delete_source,
	channels_notifications_db_advance_member_authority,
	channels_notifications_db_enqueue_sidebar,
	channels_notifications_db_enqueue_inbox,
	channels_notifications_db_get_scope,
} from "../server/channels-notifications.ts";

// Make Convex reuse the loaded module between calls. No mutable module state is allowed here.
export const experimental_reuseContext = true;

/**
 * All channel doors use this check, including file comments and agent reads.
 * A member's access belongs to one workspace membership, so a re-invite starts fresh.
 */
export async function channels_db_get_access(
	ctx: QueryCtx | MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		channel: Doc<"channels">;
	},
) {
	const { userAuth, membership, channel } = args;
	if (channel.organizationId !== membership.organizationId || channel.workspaceId !== membership.workspaceId) {
		return Result({ _nay: { message: "Not found" } });
	}
	const fileNode = channel.kind === "file" ? await files_saved_placement_db_get_node(ctx.db, channel.fileNodeId) : null;
	if (channel.kind === "file" && (!fileNode || fileNode.kind !== "file")) {
		return Result({ _nay: { message: "Not found" } });
	}
	const read = await access_control_db_authorize_membership(ctx, {
		userAuth,
		membership,
		permission: "content.read",
		...(fileNode ? { fileNode } : {}),
	});
	if (read._nay) {
		return Result({ _nay: { message: read._nay.message === "Unauthenticated" ? "Unauthenticated" : "Not found" } });
	}
	const storedMember = await ctx.db
		.query("channels_members")
		.withIndex("by_channel_user", (q) => q.eq("channelId", channel._id).eq("userId", userAuth.id))
		.unique();
	const member = storedMember?.workspaceMembershipId === membership._id ? storedMember : null;
	const owner = read._yay.organization.ownerUserId === userAuth.id;
	if ((channel.kind === "private" || channel.kind === "direct") && !member && !owner) {
		return Result({ _nay: { message: "Not found" } });
	}
	const write = await access_control_db_authorize_membership(ctx, {
		userAuth,
		membership,
		permission: "content.write",
		...(fileNode ? { fileNode } : {}),
	});
	let canPost = !write._nay && (channel.kind !== "direct" || member !== null);
	let canManage = false;
	if (channel.kind === "file") {
		const manage = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.permissions.manage",
			fileNode: fileNode!,
		});
		canManage = !manage._nay;
	} else if (channel.kind !== "direct") {
		canManage = owner || member?.level === "manager";
		if (channel.kind === "public" && !canManage) {
			const manage = await access_control_db_authorize_membership(ctx, {
				userAuth,
				membership,
				permission: "workspace.channels.manage",
			});
			canManage = !manage._nay;
		}
	}
	let postRefusal: string | null = canPost ? null : "You have view-only access";
	if (channel.kind === "direct" && channel.participantUserIds.length === 2) {
		for (const userId of channel.participantUserIds) {
			const participant = await ctx.db
				.query("channels_members")
				.withIndex("by_channel_user", (q) => q.eq("channelId", channel._id).eq("userId", userId))
				.unique();
			const currentMembership = participant
				? await ctx.db.get("organizations_workspaces_users", participant.workspaceMembershipId)
				: null;
			if (!currentMembership?.active || currentMembership.userId !== userId) {
				canPost = false;
				postRefusal = "This conversation ended";
				break;
			}
		}
	}
	if (fileNode?.archiveOperationId) {
		canPost = false;
		postRefusal = "This file is archived";
	} else if ((channel.kind === "public" || channel.kind === "private") && channel.archivedAt !== null) {
		canPost = false;
		postRefusal = "This channel is archived";
	}
	return Result({ _yay: { canRead: true as const, canPost, canManage, member, fileNode, postRefusal } });
}

async function get_context(ctx: QueryCtx | MutationCtx, membershipId: Id<"organizations_workspaces_users">) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
	const user = await ctx.db.get("users", userAuth.id);
	if (!user || user.deletedAt != null) return Result({ _nay: { message: "Unauthenticated" } });
	const membership = await organizations_db_get_membership(ctx, { membershipId, userId: userAuth.id });
	if (!membership) return Result({ _nay: { message: "Not found" } });
	return Result({ _yay: { userAuth, membership } });
}

async function get_write_context(
	ctx: MutationCtx,
	membershipId: Id<"organizations_workspaces_users">,
	channelId: Id<"channels">,
) {
	const context = await get_context(ctx, membershipId);
	if (context._nay) return context;
	const limit = await rate_limiter_limit_by_key(ctx, { name: "channels_write", key: context._yay.userAuth.id });
	if (limit) return Result({ _nay: { message: limit.message } });
	const channel = await ctx.db.get("channels", channelId);
	if (!channel) return Result({ _nay: { message: "Not found" } });
	const access = await channels_db_get_access(ctx, { ...context._yay, channel });
	if (access._nay) return access;
	return Result({ _yay: { ...context._yay, channel, access: access._yay } });
}

export async function channels_db_add_member(
	ctx: MutationCtx,
	args: {
		channel: Doc<"channels">;
		membership: Doc<"organizations_workspaces_users">;
		level: "member" | "manager";
		addedBy: Id<"users"> | null;
	},
) {
	const { channel, membership } = args;
	const existing = await ctx.db
		.query("channels_members")
		.withIndex("by_channel_user", (q) => q.eq("channelId", channel._id).eq("userId", membership.userId))
		.unique();
	if (existing?.workspaceMembershipId === membership._id) return existing._id;
	await channels_notifications_db_ensure_summary(ctx, membership);
	if (existing) await channels_notifications_db_delete_source(ctx, existing);
	const fields = {
		channelId: channel._id,
		organizationId: channel.organizationId,
		workspaceId: channel.workspaceId,
		userId: membership.userId,
		workspaceMembershipId: membership._id,
		channelKind: channel.kind,
		level: args.level,
		addedBy: args.addedBy,
		notify: "all" as const,
		starred: false,
		section:
			channel.kind === "file"
				? ("files" as const)
				: channel.kind === "direct"
					? ("direct" as const)
					: ("channels" as const),
		hidden: false,
		sidebarArchived: false,
		sidebarName: null,
		sidebarActivityAt: Date.now(),
		starredAt: null,
		visibilityRevision: 0,
		countSummaryId: null,
		countGeneration: 0,
		countedMention: false,
		hiddenAtMainSequence: null,
		joinedAt: Date.now(),
	};
	const memberId = await ctx.db.insert("channels_members", fields);
	const activity = await ctx.db
		.query("channels_activity")
		.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
		.unique();
	if (!existing) await ctx.db.patch("channels_activity", activity!._id, { memberCount: activity!.memberCount + 1 });
	if (channel.kind === "private" || channel.kind === "direct")
		await channels_notifications_db_advance_member_authority(ctx, membership);
	await channels_db_reconcile_member(ctx, (await ctx.db.get("channels_members", memberId))!);
	return memberId;
}

export async function channels_db_reconcile_member(ctx: MutationCtx, member: Doc<"channels_members">) {
	const membership = await ctx.db.get("organizations_workspaces_users", member.workspaceMembershipId);
	if (!membership?.active || membership.userId !== member.userId) return;
	const channel = await ctx.db.get("channels", member.channelId);
	if (!channel) {
		await channels_notifications_db_delete_source(ctx, member);
		return;
	}
	const access = await channels_db_get_access(ctx, { membership, channel, userAuth: { id: member.userId } });
	if (access._nay) {
		// Hidden changes must not move or remove a locked conversation.
		await channels_notifications_db_apply(ctx, member, false);
		return;
	}
	const activity = await ctx.db
		.query("channels_activity")
		.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
		.unique();
	const named = channel.kind === "public" || channel.kind === "private";
	const reopen =
		channel.kind === "direct" &&
		member.hidden &&
		member.hiddenAtMainSequence !== null &&
		(activity?.lastMainSequence ?? 0) > member.hiddenAtMainSequence;
	const fields = {
		sidebarName: named ? channel.name : null,
		sidebarArchived: named ? channel.archived : false,
		sidebarActivityAt:
			channel.kind === "direct"
				? activity?.lastMainMessageAt || member.joinedAt
				: channel.kind === "file"
					? activity?.lastMessageAt || member.joinedAt
					: member.sidebarActivityAt,
		...(reopen ? { hidden: false, hiddenAtMainSequence: null, visibilityRevision: member.visibilityRevision + 1 } : {}),
	};
	await ctx.db.patch("channels_members", member._id, fields);
	const current = { ...member, ...fields };
	const mention =
		!current.hidden && !current.sidebarArchived && (await channels_db_has_mention(ctx, membership._id, channel));
	await channels_notifications_db_apply(ctx, current, mention);
}

export async function channels_db_reconcile_member_by_channel(
	ctx: MutationCtx,
	membershipId: Id<"organizations_workspaces_users">,
	channelId: Id<"channels">,
) {
	const member = await ctx.db
		.query("channels_members")
		.withIndex("by_workspaceMembership_channel", (q) =>
			q.eq("workspaceMembershipId", membershipId).eq("channelId", channelId),
		)
		.unique();
	if (member) await channels_db_reconcile_member(ctx, member);
}

async function channels_db_has_mention(
	ctx: QueryCtx,
	membershipId: Id<"organizations_workspaces_users">,
	channel: Doc<"channels">,
) {
	const posts =
		channel.kind === "file" ||
		((channel.kind === "public" || channel.kind === "private") && channel.layout === "posts");
	if (posts)
		return !!(await ctx.db
			.query("channels_thread_followers")
			.withIndex("by_m_channel_pendingRootMention", (q) =>
				q.eq("workspaceMembershipId", membershipId).eq("channelId", channel._id).eq("pendingRootMention", true),
			)
			.first());
	const read = await ctx.db
		.query("channels_read_states")
		.withIndex("by_workspaceMembership_channel", (q) =>
			q.eq("workspaceMembershipId", membershipId).eq("channelId", channel._id),
		)
		.unique();
	return !!(await ctx.db
		.query("channels_inbox")
		.withIndex("by_m_channel_kind_retired_root_main", (q) =>
			q
				.eq("workspaceMembershipId", membershipId)
				.eq("channelId", channel._id)
				.eq("kind", "mention")
				.eq("retired", false)
				.eq("threadRootId", null)
				.gt("mainSequence", read?.readSequence ?? 0),
		)
		.first());
}

export async function channels_db_refresh_direct_members(ctx: MutationCtx, channel: Doc<"channels">) {
	const members = await ctx.db
		.query("channels_members")
		.withIndex("by_channel_user", (q) => q.eq("channelId", channel._id))
		.take(channels_LIMITS.directParticipants);
	for (const member of members) await channels_db_reconcile_member(ctx, member);
}

async function open_direct_member(ctx: MutationCtx, member: Doc<"channels_members">) {
	if (member.hidden || member.hiddenAtMainSequence !== null) {
		await ctx.db.patch("channels_members", member._id, {
			hidden: false,
			hiddenAtMainSequence: null,
			visibilityRevision: member.visibilityRevision + 1,
		});
	}
	await channels_db_reconcile_member(ctx, (await ctx.db.get("channels_members", member._id))!);
}

export const channels_member_status_validator = v.union(v.literal("active"), v.literal("left"), v.literal("locked"));

/**
 * Member lists keep a row whose person left the workspace or can no longer read the channel.
 * They mark it "left" or "locked" instead of dropping it. Dropping rows would make a page read
 * rows only to skip them, and `memberCount` would not match the list.
 */
export async function channels_db_get_member_status(
	ctx: QueryCtx,
	args: { channel: Doc<"channels">; member: Doc<"channels_members"> },
) {
	const { channel, member } = args;
	const membership = await ctx.db.get("organizations_workspaces_users", member.workspaceMembershipId);
	if (!membership?.active || membership.userId !== member.userId) return "left" as const;
	const access = await channels_db_get_access(ctx, { userAuth: { id: member.userId }, membership, channel });
	return access._nay ? ("locked" as const) : ("active" as const);
}

export async function channels_db_mark_read(
	ctx: MutationCtx,
	args: {
		channel: Doc<"channels">;
		membership: Doc<"organizations_workspaces_users">;
		sequence: number;
		allowBackwards?: boolean;
	},
) {
	await channels_notifications_db_ensure_summary(ctx, args.membership);
	const activity = await ctx.db
		.query("channels_activity")
		.withIndex("by_channel", (q) => q.eq("channelId", args.channel._id))
		.unique();
	const last =
		args.channel.kind === "file" ||
		((args.channel.kind === "public" || args.channel.kind === "private") && args.channel.layout === "posts")
			? activity!.lastChannelSequence
			: activity!.lastMainSequence;
	const current = await ctx.db
		.query("channels_read_states")
		.withIndex("by_workspaceMembership_channel", (q) =>
			q.eq("workspaceMembershipId", args.membership._id).eq("channelId", args.channel._id),
		)
		.unique();
	const bounded = Math.max(0, Math.min(args.sequence, last));
	const readSequence = args.allowBackwards ? bounded : Math.max(current?.readSequence ?? 0, bounded);
	if (current) {
		if (current.readSequence !== readSequence)
			await ctx.db.patch("channels_read_states", current._id, { readSequence, updatedAt: Date.now() });
	} else {
		await ctx.db.insert("channels_read_states", {
			channelId: args.channel._id,
			organizationId: args.channel.organizationId,
			workspaceId: args.channel.workspaceId,
			userId: args.membership.userId,
			workspaceMembershipId: args.membership._id,
			readSequence,
			updatedAt: Date.now(),
		});
	}
	await channels_notifications_db_enqueue_inbox(ctx, {
		workspaceMembershipId: args.membership._id,
		channelId: args.channel._id,
		organizationId: args.channel.organizationId,
		workspaceId: args.channel.workspaceId,
		kind: "main",
		rootMessageId: null,
		lowerExclusive: Math.min(current?.readSequence ?? 0, readSequence),
		upperInclusive: Math.max(current?.readSequence ?? 0, readSequence),
	});
	await channels_db_reconcile_member_by_channel(ctx, args.membership._id, args.channel._id);
}

export const create_channel = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		kind: v.union(v.literal("public"), v.literal("private")),
		name: v.string(),
		topic: v.string(),
		layout: v.literal("messages"),
	},
	returns: v_result({ _yay: v.object({ channelId: v.id("channels") }) }),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) return context;
		const { userAuth, membership } = context._yay;
		const limit = await rate_limiter_limit_by_key(ctx, { name: "channels_write", key: userAuth.id });
		if (limit) return Result({ _nay: { message: limit.message } });
		const write = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.write",
		});
		if (write._nay) return write;
		const read = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (read._nay) return read;
		const name = channels_normalize_name(args.name);
		if (name._nay) return name;
		if (args.topic.length > channels_LIMITS.topic) return Result({ _nay: { message: "Topic is too long" } });
		if (args.kind === "public") {
			const existing = await ctx.db
				.query("channels")
				.withIndex("by_organization_workspace_kind_name", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("kind", "public")
						.eq("name", name._yay),
				)
				.first();
			if (existing) return Result({ _nay: { message: "Channel name is already used" } });
		}
		const channelId = await ctx.db.insert("channels", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			kind: args.kind,
			name: name._yay,
			topic: args.topic,
			layout: args.layout,
			resolvableThreads: false,
			createdBy: userAuth.id,
			createdAt: Date.now(),
			archivedAt: null,
			archived: false,
		});
		await ctx.db.insert("channels_activity", {
			channelId,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			lastMainSequence: 0,
			lastMainMessageAt: 0,
			lastChannelSequence: 0,
			lastMessageAt: 0,
			memberCount: 0,
		});
		const channel = (await ctx.db.get("channels", channelId))!;
		await channels_db_add_member(ctx, { channel, membership, level: "manager", addedBy: userAuth.id });
		await channels_db_mark_read(ctx, { channel, membership, sequence: 0 });
		return Result({ _yay: { channelId } });
	},
});

export const open_direct_channel = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), otherUserIds: v.array(v.id("users")) },
	returns: v_result({ _yay: v.object({ channelId: v.id("channels") }) }),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) return context;
		const { userAuth, membership } = context._yay;
		const limit = await rate_limiter_limit_by_key(ctx, { name: "channels_write", key: userAuth.id });
		if (limit) return Result({ _nay: { message: limit.message } });
		const userIds = [...new Set([userAuth.id, ...args.otherUserIds])].sort();
		if (userIds.length > channels_LIMITS.directParticipants)
			return Result({ _nay: { message: "Choose at most 9 people" } });
		const memberships: Doc<"organizations_workspaces_users">[] = [];
		for (const userId of userIds) {
			const participant = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", membership.workspaceId).eq("userId", userId).eq("active", true),
				)
				.unique();
			if (!participant || participant.organizationId !== membership.organizationId)
				return Result({ _nay: { message: "Person is not in this workspace" } });
			const read = await access_control_db_authorize_membership(ctx, {
				userAuth: { id: userId },
				membership: participant,
				permission: "content.read",
			});
			const write = await access_control_db_authorize_membership(ctx, {
				userAuth: { id: userId },
				membership: participant,
				permission: "content.write",
			});
			if (read._nay || write._nay) return Result({ _nay: { message: "Each person needs read and write access" } });
			memberships.push(participant);
		}
		const directKey = memberships
			.map((item) => item._id)
			.sort()
			.join(":");
		const existing = await ctx.db
			.query("channels")
			.withIndex("by_organization_workspace_directKey", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("directKey", directKey),
			)
			.unique();
		if (existing) {
			const own = await ctx.db
				.query("channels_members")
				.withIndex("by_channel_user", (q) => q.eq("channelId", existing._id).eq("userId", userAuth.id))
				.unique();
			await open_direct_member(ctx, own!);
			return Result({ _yay: { channelId: existing._id } });
		}
		const channelId = await ctx.db.insert("channels", {
			kind: "direct",
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			directKey,
			participantUserIds: userIds,
			createdBy: userAuth.id,
			createdAt: Date.now(),
		});
		await ctx.db.insert("channels_activity", {
			channelId,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			lastMainSequence: 0,
			lastMainMessageAt: 0,
			lastChannelSequence: 0,
			lastMessageAt: 0,
			memberCount: 0,
		});
		const channel = (await ctx.db.get("channels", channelId))!;
		for (const participant of memberships) {
			await channels_db_add_member(ctx, { channel, membership: participant, level: "member", addedBy: userAuth.id });
			await channels_db_mark_read(ctx, { channel, membership: participant, sequence: 0 });
		}
		return Result({ _yay: { channelId } });
	},
});

export const open_direct_channel_by_id = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		channelId: v.id("channels"),
		expectedVisibilityRevision: v.number(),
	},
	returns: v_result({ _yay: v.object({ opened: v.boolean() }) }),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) return context;
		const channel = await ctx.db.get("channels", args.channelId);
		if (!channel || channel.kind !== "direct") return Result({ _nay: { message: "Not found" } });
		const access = await channels_db_get_access(ctx, { ...context._yay, channel });
		if (access._nay) return access;
		const member = access._yay.member;
		if (!member) return Result({ _nay: { message: "Not found" } });
		// Visible and stale choices are reads. Charge only a real reopen.
		if (member.visibilityRevision !== args.expectedVisibilityRevision)
			return Result({ _yay: { opened: false } });
		if (!member.hidden && member.hiddenAtMainSequence === null) return Result({ _yay: { opened: true } });
		const limit = await rate_limiter_limit_by_key(ctx, { name: "channels_write", key: context._yay.userAuth.id });
		if (limit) return Result({ _nay: { message: limit.message } });
		await open_direct_member(ctx, member);
		return Result({ _yay: { opened: true } });
	},
});

export const get_channel = query({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.string() },
	returns: v.union(
		v.null(),
		v.object({
			channel: doc(app_convex_schema, "channels"),
			canPost: v.boolean(),
			canManage: v.boolean(),
			postRefusal: v.union(v.string(), v.null()),
			file: v.union(v.object({ name: v.string(), path: v.string(), archived: v.boolean() }), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return null;
		}
		const channelId = ctx.db.normalizeId("channels", args.channelId);
		if (!channelId) return null;
		const channel = await ctx.db.get("channels", channelId);
		if (!channel) return null;
		const access = await channels_db_get_access(ctx, { ...context._yay, channel });
		if (access._nay) return null;
		const { fileNode, canPost, canManage, postRefusal } = access._yay;
		return {
			channel,
			canPost,
			canManage,
			postRefusal,
			file: fileNode ? { name: fileNode.name, path: fileNode.path, archived: !!fileNode.archiveOperationId } : null,
		};
	},
});

export const get_channel_state = query({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels") },
	returns: v.union(
		v.null(),
		v.object({
			activity: doc(app_convex_schema, "channels_activity"),
			member: v.union(
				v.object({
					_id: v.id("channels_members"),
					userId: v.id("users"),
					level: v.union(v.literal("member"), v.literal("manager")),
					notify: v.union(v.literal("all"), v.literal("mentions"), v.literal("none")),
					starred: v.boolean(),
					hidden: v.boolean(),
					visibilityRevision: v.number(),
				}),
				v.null(),
			),
			readSequence: v.number(),
			unread: v.boolean(),
			mentionCount: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return null;
		}
		const channel = await ctx.db.get("channels", args.channelId);
		if (!channel) return null;
		const access = await channels_db_get_access(ctx, { ...context._yay, channel });
		if (access._nay) return null;
		const activity = (await ctx.db
			.query("channels_activity")
			.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
			.unique())!;
		const membershipId = context._yay.membership._id;
		const read = await ctx.db
			.query("channels_read_states")
			.withIndex("by_workspaceMembership_channel", (q) =>
				q.eq("workspaceMembershipId", membershipId).eq("channelId", channel._id),
			)
			.unique();
		const readSequence = read?.readSequence ?? 0;
		const posts =
			channel.kind === "file" ||
			((channel.kind === "public" || channel.kind === "private") && channel.layout === "posts");
		const mentions = posts
			? await ctx.db
					.query("channels_thread_followers")
					.withIndex("by_m_channel_pendingRootMention", (q) =>
						q.eq("workspaceMembershipId", membershipId).eq("channelId", channel._id).eq("pendingRootMention", true),
					)
					.take(100)
			: await ctx.db
					.query("channels_inbox")
					.withIndex("by_m_channel_kind_retired_root_main", (q) =>
						q
							.eq("workspaceMembershipId", membershipId)
							.eq("channelId", channel._id)
							.eq("kind", "mention")
							.eq("retired", false)
							.eq("threadRootId", null)
							.gt("mainSequence", readSequence),
					)
					.take(100);
		return {
			activity,
			member: access._yay.member
				? {
						_id: access._yay.member._id,
						userId: access._yay.member.userId,
						level: access._yay.member.level,
						notify: access._yay.member.notify,
						starred: access._yay.member.starred,
						hidden: access._yay.member.hidden,
						visibilityRevision: access._yay.member.visibilityRevision,
					}
				: null,
			readSequence,
			unread:
				access._yay.member !== null &&
				(posts ? activity.lastChannelSequence : activity.lastMainSequence) > readSequence,
			mentionCount: mentions.length,
		};
	},
});

const channel_kind_validator = v.union(
	v.literal("public"),
	v.literal("private"),
	v.literal("direct"),
	v.literal("file"),
);
const member_channel_validator = v.union(
	v.object({
		state: v.literal("readable"),
		memberId: v.id("channels_members"),
		channel: doc(app_convex_schema, "channels"),
	}),
	v.object({ state: v.literal("locked"), memberId: v.id("channels_members"), kind: channel_kind_validator }),
	v.object({ state: v.literal("unavailable"), memberId: v.id("channels_members"), kind: channel_kind_validator }),
);

async function shape_member_channel(
	ctx: QueryCtx,
	membership: Doc<"organizations_workspaces_users">,
	member: Doc<"channels_members">,
) {
	const channel = await ctx.db.get("channels", member.channelId);
	if (!channel) return { state: "unavailable" as const, memberId: member._id, kind: member.channelKind };
	const access = await channels_db_get_access(ctx, { membership, userAuth: { id: membership.userId }, channel });
	if (access._nay) return { state: "locked" as const, memberId: member._id, kind: member.channelKind };
	return { state: "readable" as const, memberId: member._id, channel };
}

export const list_my_channels = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		section: v.union(v.literal("starred"), v.literal("channels"), v.literal("direct"), v.literal("files")),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(member_channel_validator),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const { membership } = context._yay;
		const members =
			args.section === "starred"
				? ctx.db
						.query("channels_members")
						.withIndex("by_m_star_hidden_archived_starredAt", (q) =>
							q
								.eq("workspaceMembershipId", membership._id)
								.eq("starred", true)
								.eq("hidden", false)
								.eq("sidebarArchived", false),
						)
						.order("desc")
				: args.section === "channels"
					? ctx.db
							.query("channels_members")
							.withIndex("by_m_star_hidden_archived_section_name", (q) =>
								q
									.eq("workspaceMembershipId", membership._id)
									.eq("starred", false)
									.eq("hidden", false)
									.eq("sidebarArchived", false)
									.eq("section", "channels"),
							)
					: ctx.db
							.query("channels_members")
							.withIndex("by_m_star_hidden_archived_section_activity", (q) =>
								q
									.eq("workspaceMembershipId", membership._id)
									.eq("starred", false)
									.eq("hidden", false)
									.eq("sidebarArchived", false)
									.eq("section", args.section === "direct" ? "direct" : "files"),
							)
							.order("desc");
		const page = await members.paginate({
			...args.paginationOpts,
			numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems),
			maximumRowsRead: channels_LIMITS.page,
			maximumBytesRead: channels_LIMITS.pageBytes,
		});
		return {
			...page,
			page: await Promise.all(page.page.map((member) => shape_member_channel(ctx, membership, member))),
		};
	},
});

export const browse_public_channels = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		archived: v.boolean(),
		prefix: v.string(),
		accessScopeKey: v.string(),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(doc(app_convex_schema, "channels")),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const { membership, userAuth } = context._yay;
		const scope = await channels_notifications_db_get_scope(ctx, membership);
		if (scope.accessScopeKey !== args.accessScopeKey) return { page: [], isDone: true, continueCursor: "" };
		const prefix = args.prefix.trim().toLowerCase();
		if (prefix && channels_normalize_name(prefix)._nay) return { page: [], isDone: true, continueCursor: "" };
		const upperBound = string_prefix_upper_bound(prefix);
		const read = await access_control_db_authorize_membership(ctx, {
			membership,
			userAuth,
			permission: "content.read",
		});
		if (read._nay) return { page: [], isDone: true, continueCursor: "" };
		return ctx.db
			.query("channels")
			.withIndex("by_organization_workspace_kind_archived_name", (q) => {
				const scoped = q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("kind", "public")
					.eq("archived", args.archived);
				if (!prefix) return scoped;
				return upperBound === null ? scoped.gte("name", prefix) : scoped.gte("name", prefix).lt("name", upperBound);
			})
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems),
				maximumRowsRead: channels_LIMITS.page,
			});
	},
});

export const search_my_private_channels = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		accessScopeKey: v.string(),
		archived: v.boolean(),
		prefix: v.string(),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(member_channel_validator),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const { membership } = context._yay;
		const scope = await channels_notifications_db_get_scope(ctx, membership);
		if (scope.accessScopeKey !== args.accessScopeKey) return { page: [], isDone: true, continueCursor: "" };
		const prefix = args.prefix.trim().toLowerCase();
		if (prefix && channels_normalize_name(prefix)._nay) return { page: [], isDone: true, continueCursor: "" };
		const upperBound = string_prefix_upper_bound(prefix);
		// Frozen names keep denied matches; the row shaper checks current access.
		const page = await ctx.db
			.query("channels_members")
			.withIndex("by_m_kind_archived_name", (q) => {
				const scoped = q
					.eq("workspaceMembershipId", membership._id)
					.eq("channelKind", "private")
					.eq("sidebarArchived", args.archived);
				if (!prefix) return scoped;
				return upperBound === null
					? scoped.gte("sidebarName", prefix)
					: scoped.gte("sidebarName", prefix).lt("sidebarName", upperBound);
			})
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems),
				maximumRowsRead: channels_LIMITS.page,
				maximumBytesRead: channels_LIMITS.pageBytes,
			});
		return {
			...page,
			page: await Promise.all(page.page.map((member) => shape_member_channel(ctx, membership, member))),
		};
	},
});

export const list_my_channel_kind = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		accessScopeKey: v.string(),
		kind: v.union(v.literal("direct"), v.literal("file")),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(member_channel_validator),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const { membership } = context._yay;
		const scope = await channels_notifications_db_get_scope(ctx, membership);
		if (scope.accessScopeKey !== args.accessScopeKey) return { page: [], isDone: true, continueCursor: "" };
		const page = await ctx.db
			.query("channels_members")
			.withIndex("by_workspaceMembership_channelKind_channel", (q) =>
				q.eq("workspaceMembershipId", membership._id).eq("channelKind", args.kind),
			)
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems),
				maximumRowsRead: channels_LIMITS.page,
				maximumBytesRead: channels_LIMITS.pageBytes,
			});
		return {
			...page,
			page: await Promise.all(page.page.map((member) => shape_member_channel(ctx, membership, member))),
		};
	},
});

export const mark_read = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels"), sequence: v.number() },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) return context;
		const channel = await ctx.db.get("channels", args.channelId);
		if (!channel) return Result({ _nay: { message: "Not found" } });
		const access = await channels_db_get_access(ctx, { ...context._yay, channel });
		if (access._nay) return access;
		if ((channel.kind === "private" || channel.kind === "direct") && !access._yay.member) return Result({ _yay: null });
		if (!Number.isSafeInteger(args.sequence) || args.sequence < 0)
			return Result({ _nay: { message: "Invalid read position" } });
		await channels_db_mark_read(ctx, { channel, membership: context._yay.membership, sequence: args.sequence });
		return Result({ _yay: null });
	},
});

export const join_channel = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, membership } = context._yay;
		if (channel.kind !== "public" && channel.kind !== "file")
			return Result({ _nay: { message: "This channel needs an invitation" } });
		await channels_db_add_member(ctx, { channel, membership, level: "member", addedBy: null });
		await channels_db_mark_read(ctx, { channel, membership, sequence: 0 });
		return Result({ _yay: null });
	},
});

export async function channels_db_ensure_file_channel(
	ctx: MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users">; fileNodeId: Id<"files_nodes">; userId: Id<"users"> },
) {
	const existing = await ctx.db
		.query("channels")
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q
				.eq("organizationId", args.membership.organizationId)
				.eq("workspaceId", args.membership.workspaceId)
				.eq("fileNodeId", args.fileNodeId),
		)
		.unique();
	if (existing) return existing;
	const channelId = await ctx.db.insert("channels", {
		kind: "file",
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		fileNodeId: args.fileNodeId,
		createdBy: args.userId,
		createdAt: Date.now(),
	});
	await ctx.db.insert("channels_activity", {
		channelId,
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		lastMainSequence: 0,
		lastMainMessageAt: 0,
		lastChannelSequence: 0,
		lastMessageAt: 0,
		memberCount: 0,
	});
	return (await ctx.db.get("channels", channelId))!;
}

export const get_file_channel = query({
	args: { membershipId: v.id("organizations_workspaces_users"), fileNodeId: v.id("files_nodes") },
	returns: v.union(v.id("channels"), v.null()),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return null;
		}
		const { membership, userAuth } = context._yay;
		const read = await access_control_db_authorize_node(ctx, {
			membership,
			userAuth,
			nodeId: args.fileNodeId,
			permission: "content.read",
		});
		if (read._nay || read._yay.fileNode.kind !== "file") return null;
		const channel = await ctx.db
			.query("channels")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("fileNodeId", args.fileNodeId),
			)
			.unique();
		return channel?._id ?? null;
	},
});

export const rename_channel = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels"), name: v.string() },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, access } = context._yay;
		if (!access.canManage || (channel.kind !== "public" && channel.kind !== "private"))
			return Result({ _nay: { message: "Permission denied" } });
		const name = channels_normalize_name(args.name);
		if (name._nay) return name;
		if (channel.kind === "public") {
			const existing = await ctx.db
				.query("channels")
				.withIndex("by_organization_workspace_kind_name", (q) =>
					q
						.eq("organizationId", channel.organizationId)
						.eq("workspaceId", channel.workspaceId)
						.eq("kind", "public")
						.eq("name", name._yay),
				)
				.first();
			if (existing && existing._id !== channel._id)
				return Result({ _nay: { message: "Channel name is already used" } });
		}
		await ctx.db.patch("channels", channel._id, { name: name._yay });
		await channels_notifications_db_enqueue_sidebar(ctx, channel);
		return Result({ _yay: null });
	},
});

export const set_channel_topic = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels"), topic: v.string() },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, access } = context._yay;
		if (!access.canManage || (channel.kind !== "public" && channel.kind !== "private"))
			return Result({ _nay: { message: "Permission denied" } });
		if (args.topic.length > channels_LIMITS.topic) return Result({ _nay: { message: "Topic is too long" } });
		await ctx.db.patch("channels", channel._id, { topic: args.topic });
		return Result({ _yay: null });
	},
});

export const set_channel_resolvable_threads = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		channelId: v.id("channels"),
		resolvableThreads: v.boolean(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, access } = context._yay;
		if (!access.canManage || (channel.kind !== "public" && channel.kind !== "private"))
			return Result({ _nay: { message: "Permission denied" } });
		await ctx.db.patch("channels", channel._id, { resolvableThreads: args.resolvableThreads });
		return Result({ _yay: null });
	},
});

export const archive_channel = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, access } = context._yay;
		if (!access.canManage || (channel.kind !== "public" && channel.kind !== "private"))
			return Result({ _nay: { message: "Permission denied" } });
		await ctx.db.patch("channels", channel._id, { archivedAt: Date.now(), archived: true });
		await channels_notifications_db_enqueue_sidebar(ctx, channel);
		return Result({ _yay: null });
	},
});

export const unarchive_channel = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, access } = context._yay;
		if (!access.canManage || (channel.kind !== "public" && channel.kind !== "private"))
			return Result({ _nay: { message: "Permission denied" } });
		await ctx.db.patch("channels", channel._id, { archivedAt: null, archived: false });
		await channels_notifications_db_enqueue_sidebar(ctx, channel);
		return Result({ _yay: null });
	},
});

async function delete_member(ctx: MutationCtx, member: Doc<"channels_members">, repairAccess = true) {
	await channels_notifications_db_delete_source(ctx, member);
	if (repairAccess && (member.channelKind === "private" || member.channelKind === "direct")) {
		const membership = await ctx.db.get("organizations_workspaces_users", member.workspaceMembershipId);
		const user = membership?.active ? await ctx.db.get("users", membership.userId) : null;
		if (membership?.active && user && user.deletedAt == null)
			await channels_notifications_db_advance_member_authority(ctx, membership);
	}
	const activity = await ctx.db
		.query("channels_activity")
		.withIndex("by_channel", (q) => q.eq("channelId", member.channelId))
		.unique();
	if (activity) await ctx.db.patch("channels_activity", activity._id, { memberCount: activity.memberCount - 1 });
}

export const leave_channel = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, access } = context._yay;
		if (channel.kind === "direct") return Result({ _nay: { message: "Hide this conversation instead" } });
		if (access.member) await delete_member(ctx, access.member);
		return Result({ _yay: null });
	},
});

export const hide_direct_channel = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, access } = context._yay;
		if (channel.kind !== "direct" || !access.member) return Result({ _nay: { message: "Not found" } });
		const activity = (await ctx.db
			.query("channels_activity")
			.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
			.unique())!;
		await ctx.db.patch("channels_members", access.member._id, {
			hidden: true,
			hiddenAtMainSequence: activity.lastMainSequence,
			visibilityRevision: access.member.visibilityRevision + 1,
		});
		await channels_db_reconcile_member(ctx, (await ctx.db.get("channels_members", access.member._id))!);
		return Result({ _yay: null });
	},
});

export const add_channel_members = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		channelId: v.id("channels"),
		userIds: v.array(v.id("users")),
		level: v.union(v.literal("member"), v.literal("manager")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, access, userAuth } = context._yay;
		if (channel.kind !== "private" || !access.canManage) return Result({ _nay: { message: "Permission denied" } });
		const userIds = [...new Set(args.userIds)];
		if (userIds.length > channels_LIMITS.page) return Result({ _nay: { message: "Add at most 50 people at once" } });
		const memberships: Doc<"organizations_workspaces_users">[] = [];
		let added = 0;
		for (const userId of userIds) {
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", channel.workspaceId).eq("userId", userId).eq("active", true),
				)
				.unique();
			if (!membership || membership.organizationId !== channel.organizationId)
				return Result({ _nay: { message: "Person is not in this workspace" } });
			const read = await access_control_db_authorize_membership(ctx, {
				membership,
				userAuth: { id: userId },
				permission: "content.read",
			});
			if (read._nay) return Result({ _nay: { message: "Person cannot see this workspace" } });
			const existing = await ctx.db
				.query("channels_members")
				.withIndex("by_channel_user", (q) => q.eq("channelId", channel._id).eq("userId", userId))
				.unique();
			if (!existing) added += 1;
			memberships.push(membership);
		}
		const activity = (await ctx.db
			.query("channels_activity")
			.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
			.unique())!;
		if (activity.memberCount + added > channels_LIMITS.privateMembers)
			return Result({ _nay: { message: "Channel has reached 1,000 members" } });
		for (const membership of memberships)
			await channels_db_add_member(ctx, { channel, membership, level: args.level, addedBy: userAuth.id });
		return Result({ _yay: null });
	},
});

export const set_channel_member_level = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		channelId: v.id("channels"),
		userId: v.id("users"),
		level: v.union(v.literal("member"), v.literal("manager")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, access } = context._yay;
		if (channel.kind !== "private" || !access.canManage) return Result({ _nay: { message: "Permission denied" } });
		const member = await ctx.db
			.query("channels_members")
			.withIndex("by_channel_user", (q) => q.eq("channelId", channel._id).eq("userId", args.userId))
			.unique();
		const membership = member ? await ctx.db.get("organizations_workspaces_users", member.workspaceMembershipId) : null;
		if (!member || !membership?.active) return Result({ _nay: { message: "Not found" } });
		await ctx.db.patch("channels_members", member._id, { level: args.level });
		return Result({ _yay: null });
	},
});

export const remove_channel_member = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels"), userId: v.id("users") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		const { channel, access } = context._yay;
		if (channel.kind !== "private" || !access.canManage) return Result({ _nay: { message: "Permission denied" } });
		const member = await ctx.db
			.query("channels_members")
			.withIndex("by_channel_user", (q) => q.eq("channelId", channel._id).eq("userId", args.userId))
			.unique();
		if (member) await delete_member(ctx, member);
		return Result({ _yay: null });
	},
});

export const set_channel_notify = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		channelId: v.id("channels"),
		notify: v.union(v.literal("all"), v.literal("mentions"), v.literal("none")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		if (!context._yay.access.member) return Result({ _nay: { message: "Join the channel first" } });
		await ctx.db.patch("channels_members", context._yay.access.member._id, { notify: args.notify });
		return Result({ _yay: null });
	},
});

export const set_channel_starred = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), channelId: v.id("channels"), starred: v.boolean() },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_write_context(ctx, args.membershipId, args.channelId);
		if (context._nay) return context;
		if (!context._yay.access.member) return Result({ _nay: { message: "Join the channel first" } });
		const member = context._yay.access.member;
		if (member.starred !== args.starred)
			await ctx.db.patch("channels_members", member._id, {
				starred: args.starred,
				starredAt: args.starred ? Date.now() : null,
			});
		return Result({ _yay: null });
	},
});

export const list_channel_members = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		channelId: v.id("channels"),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			member: v.object({
				_id: v.id("channels_members"),
				userId: v.id("users"),
				level: v.union(v.literal("member"), v.literal("manager")),
			}),
			status: channels_member_status_validator,
		}),
	),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) {
			if (context._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return { page: [], isDone: true, continueCursor: "" };
		}
		const channel = await ctx.db.get("channels", args.channelId);
		if (!channel) return { page: [], isDone: true, continueCursor: "" };
		const access = await channels_db_get_access(ctx, { ...context._yay, channel });
		if (access._nay) return { page: [], isDone: true, continueCursor: "" };
		const members = await ctx.db
			.query("channels_members")
			.withIndex("by_channel_user", (q) => q.eq("channelId", channel._id))
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(channels_LIMITS.page, args.paginationOpts.numItems),
				maximumRowsRead: channels_LIMITS.page,
			});
		const page = [];
		for (const member of members.page)
			page.push({
				member: { _id: member._id, userId: member.userId, level: member.level },
				status: await channels_db_get_member_status(ctx, { channel, member }),
			});
		return { ...members, page };
	},
});

export const mark_unread = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), messageId: v.id("channels_messages") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args.membershipId);
		if (context._nay) return context;
		const message = await ctx.db.get("channels_messages", args.messageId);
		if (!message || message.deletedAt !== null) return Result({ _nay: { message: "Not found" } });
		const channel = await ctx.db.get("channels", message.channelId);
		if (!channel) return Result({ _nay: { message: "Not found" } });
		const access = await channels_db_get_access(ctx, { ...context._yay, channel });
		if (access._nay) return access;
		if ((channel.kind === "private" || channel.kind === "direct") && !access._yay.member) return Result({ _yay: null });
		const posts =
			channel.kind === "file" ||
			((channel.kind === "public" || channel.kind === "private") && channel.layout === "posts");
		const sequence = posts ? message.channelSequence : message.mainSequence;
		if (sequence === null) return Result({ _nay: { message: "Open this thread to change its read position" } });
		await channels_db_mark_read(ctx, {
			channel,
			membership: context._yay.membership,
			sequence: sequence - 1,
			allowBackwards: true,
		});
		return Result({ _yay: null });
	},
});

/**
 * Member removal and account finalization keep messages but remove personal channel state.
 * Each call drains at most 100 rows from one table.
 */
export async function channels_db_drain_member_batch(
	ctx: MutationCtx,
	args: { organizationId?: Id<"organizations">; userId: Id<"users"> },
) {
	const members = await (
		args.organizationId
			? ctx.db
					.query("channels_members")
					.withIndex("by_organization_user", (q) =>
						q.eq("organizationId", args.organizationId!).eq("userId", args.userId),
					)
			: ctx.db.query("channels_members").withIndex("by_user", (q) => q.eq("userId", args.userId))
	).take(100);
	if (members.length) {
		for (const member of members) await delete_member(ctx, member, false);
		return { drainedAny: true };
	}
	const reads = await (
		args.organizationId
			? ctx.db
					.query("channels_read_states")
					.withIndex("by_organization_user", (q) =>
						q.eq("organizationId", args.organizationId!).eq("userId", args.userId),
					)
			: ctx.db.query("channels_read_states").withIndex("by_user", (q) => q.eq("userId", args.userId))
	).take(100);
	if (reads.length) {
		await Promise.all(reads.map((read) => ctx.db.delete("channels_read_states", read._id)));
		return { drainedAny: true };
	}
	const followers = await (
		args.organizationId
			? ctx.db
					.query("channels_thread_followers")
					.withIndex("by_organization_user", (q) =>
						q.eq("organizationId", args.organizationId!).eq("userId", args.userId),
					)
			: ctx.db.query("channels_thread_followers").withIndex("by_user", (q) => q.eq("userId", args.userId))
	).take(100);
	if (followers.length) {
		for (const follower of followers) await channels_notifications_db_delete_source(ctx, follower);
		return { drainedAny: true };
	}
	const inbox = await (
		args.organizationId
			? ctx.db
					.query("channels_inbox")
					.withIndex("by_organization_recipient", (q) =>
						q.eq("organizationId", args.organizationId!).eq("recipientUserId", args.userId),
					)
			: ctx.db.query("channels_inbox").withIndex("by_recipient", (q) => q.eq("recipientUserId", args.userId))
	).take(100);
	for (const item of inbox) await channels_notifications_db_delete_source(ctx, item);
	if (inbox.length) return { drainedAny: true };
	const summaries = await (
		args.organizationId
			? ctx.db
					.query("channels_summaries")
					.withIndex("by_organization_user", (q) =>
						q.eq("organizationId", args.organizationId!).eq("userId", args.userId),
					)
			: ctx.db.query("channels_summaries").withIndex("by_user", (q) => q.eq("userId", args.userId))
	).take(100);
	for (const summary of summaries) {
		for (const table of ["channels_inbox_jobs", "channels_summary_jobs"] as const) {
			const jobs = await ctx.db
				.query(table)
				.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", summary.workspaceMembershipId))
				.take(100);
			for (const job of jobs) await ctx.db.delete(table, job._id);
			if (jobs.length) return { drainedAny: true };
		}
		await ctx.db.delete("channels_summaries", summary._id);
	}
	return { drainedAny: summaries.length > 0 };
}

/**
 * Delete channel children before their parents during a workspace purge.
 */
export async function channels_db_purge_workspace_batch(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; batchSize: number },
) {
	const { organizationId, workspaceId, batchSize } = args;
	for (const table of [
		"channels_reactions",
		"channels_reaction_counts",
		"channels_inbox",
		"channels_thread_followers",
		"channels_uploads",
		"channels_threads",
		"channels_messages",
		"channels_read_states",
		"channels_sidebar_jobs",
		"channels_thread_jobs",
		"channels_inbox_jobs",
		"channels_summary_jobs",
		"channels_authority_jobs",
		"channels_move_authority_proofs",
		"channels_authority_versions",
	] as const) {
		const rows = await ctx.db
			.query(table)
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
			)
			.take(batchSize);
		if (rows.length) {
			for (const row of rows) {
				if ("countedUnread" in row) await channels_notifications_db_delete_source(ctx, row);
				else await ctx.db.delete(table, row._id);
			}
			return rows.length;
		}
	}
	const members = await ctx.db
		.query("channels_members")
		.withIndex("by_organization_workspace_user_channel", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (members.length) {
		for (const member of members) await channels_notifications_db_delete_source(ctx, member);
		return members.length;
	}
	const summaries = await ctx.db
		.query("channels_summaries")
		.withIndex("by_organization_workspace_membership", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (summaries.length) {
		for (const summary of summaries) await ctx.db.delete("channels_summaries", summary._id);
		return summaries.length;
	}
	const activity = await ctx.db
		.query("channels_activity")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	if (activity.length) {
		await Promise.all(activity.map((row) => ctx.db.delete("channels_activity", row._id)));
		return activity.length;
	}
	const channels = await ctx.db
		.query("channels")
		.withIndex("by_organization_workspace_kind_name", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.take(batchSize);
	await Promise.all(channels.map((channel) => ctx.db.delete("channels", channel._id)));
	return channels.length;
}
