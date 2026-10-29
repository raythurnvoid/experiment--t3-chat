import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { internal } from "../convex/_generated/api.js";

type WriteContext = Pick<MutationCtx, "db" | "scheduler">;
type Scope = { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> | null };
type CountSource = Doc<"channels_members"> | Doc<"channels_inbox"> | Doc<"channels_thread_followers">;

export const channels_notifications_JOB_WATCHDOG_MS = 60_000;

export async function channels_notifications_db_get_authority_pins(
	db: QueryCtx["db"],
	scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	const [organization, workspace] = await Promise.all([
		db
			.query("channels_authority_versions")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", null),
			)
			.unique(),
		db
			.query("channels_authority_versions")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
			)
			.unique(),
	]);
	return {
		organizationAuthorityPin: organization ? { id: organization._id, revision: organization.revision } : null,
		workspaceAuthorityPin: workspace ? { id: workspace._id, revision: workspace.revision } : null,
	};
}

export function channels_notifications_authority_matches(
	summary: Doc<"channels_summaries">,
	pins: Pick<Doc<"channels_summaries">, "organizationAuthorityPin" | "workspaceAuthorityPin">,
) {
	return (
		summary.organizationAuthorityPin?.id === pins.organizationAuthorityPin?.id &&
		summary.organizationAuthorityPin?.revision === pins.organizationAuthorityPin?.revision &&
		summary.workspaceAuthorityPin?.id === pins.workspaceAuthorityPin?.id &&
		summary.workspaceAuthorityPin?.revision === pins.workspaceAuthorityPin?.revision &&
		summary.authorityRevision === summary.repairedAuthorityRevision
	);
}

export async function channels_notifications_db_get_scope(
	ctx: Pick<QueryCtx, "db">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const pins = await channels_notifications_db_get_authority_pins(ctx.db, membership);
	const summary = await ctx.db
		.query("channels_summaries")
		.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", membership._id))
		.unique();
	const accessScopeKey = JSON.stringify([
		membership._id,
		pins.organizationAuthorityPin,
		pins.workspaceAuthorityPin,
		summary ? { id: summary._id, revision: summary.authorityRevision } : null,
	]);
	return { pins, summary, accessScopeKey };
}

export async function channels_notifications_db_has_sources(
	db: QueryCtx["db"],
	membershipId: Id<"organizations_workspaces_users">,
) {
	const [member, inbox, follower] = await Promise.all([
		db
			.query("channels_members")
			.withIndex("by_workspaceMembership_channel", (q) => q.eq("workspaceMembershipId", membershipId))
			.first(),
		db
			.query("channels_inbox")
			.withIndex("by_workspaceMembership_createdAt", (q) => q.eq("workspaceMembershipId", membershipId))
			.first(),
		db
			.query("channels_thread_followers")
			.withIndex("by_workspaceMembership_thread", (q) => q.eq("workspaceMembershipId", membershipId))
			.first(),
	]);
	return !!(member || inbox || follower);
}

export async function channels_notifications_db_start_repair(ctx: WriteContext, summary: Doc<"channels_summaries">) {
	const pins = await channels_notifications_db_get_authority_pins(ctx.db, summary);
	const generation = summary.generation + 1;
	await ctx.db.patch("channels_summaries", summary._id, {
		...pins,
		generation,
		ready: false,
		repairedAuthorityRevision: summary.authorityRevision,
		mentionChannels: 0,
		unreadInbox: 0,
		unreadThreads: 0,
	});
	const oldJob = await ctx.db
		.query("channels_summary_jobs")
		.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", summary.workspaceMembershipId))
		.unique();
	if (oldJob) await ctx.db.delete("channels_summary_jobs", oldJob._id);
	const jobId = await ctx.db.insert("channels_summary_jobs", {
		workspaceMembershipId: summary.workspaceMembershipId,
		organizationId: summary.organizationId,
		workspaceId: summary.workspaceId,
		summaryId: summary._id,
		generation,
		phase: "members",
		cursor: null,
		dueAt: Date.now() + channels_notifications_JOB_WATCHDOG_MS,
		scheduledId: null,
	});
	const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_summary_job, {
		jobId,
		expectedCursor: null,
		expectedPhase: "members",
	});
	await ctx.db.patch("channels_summary_jobs", jobId, { scheduledId });
	return (await ctx.db.get("channels_summaries", summary._id))!;
}

export async function channels_notifications_db_ensure_summary(
	ctx: WriteContext,
	membership: Doc<"organizations_workspaces_users">,
) {
	const { summary, pins } = await channels_notifications_db_get_scope(ctx, membership);
	if (summary) {
		return channels_notifications_authority_matches(summary, pins)
			? summary
			: channels_notifications_db_start_repair(ctx, summary);
	}
	const hasSources = await channels_notifications_db_has_sources(ctx.db, membership._id);
	const id = await ctx.db.insert("channels_summaries", {
		workspaceMembershipId: membership._id,
		userId: membership.userId,
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		generation: 0,
		authorityRevision: 0,
		repairedAuthorityRevision: 0,
		...pins,
		ready: !hasSources,
		mentionChannels: 0,
		unreadInbox: 0,
		unreadThreads: 0,
	});
	const created = (await ctx.db.get("channels_summaries", id))!;
	return hasSources ? channels_notifications_db_start_repair(ctx, created) : created;
}

export async function channels_notifications_db_advance_member_authority(
	ctx: WriteContext,
	membership: Doc<"organizations_workspaces_users">,
) {
	const summary = await channels_notifications_db_ensure_summary(ctx, membership);
	await ctx.db.patch("channels_summaries", summary._id, { authorityRevision: summary.authorityRevision + 1 });
	return channels_notifications_db_start_repair(ctx, { ...summary, authorityRevision: summary.authorityRevision + 1 });
}

export async function channels_notifications_db_advance_authority(ctx: WriteContext, scope: Scope) {
	const organization = await ctx.db.get("organizations", scope.organizationId);
	if (!organization) return;
	if (scope.workspaceId) {
		const workspace = await ctx.db.get("organizations_workspaces", scope.workspaceId);
		if (!workspace || workspace.organizationId !== scope.organizationId) return;
	}
	const clock = await ctx.db
		.query("channels_authority_versions")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
		)
		.unique();
	if (clock) await ctx.db.patch("channels_authority_versions", clock._id, { revision: clock.revision + 1 });
	else
		await ctx.db.insert("channels_authority_versions", {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			revision: 1,
		});
	const existing = await ctx.db
		.query("channels_authority_jobs")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
		)
		.unique();
	if (existing) {
		await ctx.db.patch("channels_authority_jobs", existing._id, { requestedRevision: existing.requestedRevision + 1 });
		return;
	}
	const jobId = await ctx.db.insert("channels_authority_jobs", {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		requestedRevision: 1,
		passRevision: 1,
		cursor: null,
		dueAt: Date.now() + channels_notifications_JOB_WATCHDOG_MS,
		scheduledId: null,
	});
	const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_authority_job, {
		jobId,
		expectedCursor: null,
		expectedRevision: 1,
	});
	await ctx.db.patch("channels_authority_jobs", jobId, { scheduledId });
}

/**
 * Replace one source's contribution. Old generations were zeroed by their repair.
 */
export async function channels_notifications_db_apply(ctx: WriteContext, source: CountSource, next: boolean) {
	const membership = await ctx.db.get("organizations_workspaces_users", source.workspaceMembershipId);
	const userId = "recipientUserId" in source ? source.recipientUserId : source.userId;
	if (
		!membership?.active ||
		membership.userId !== userId ||
		membership.organizationId !== source.organizationId ||
		membership.workspaceId !== source.workspaceId
	)
		return;
	const user = await ctx.db.get("users", userId);
	if (!user || user.deletedAt != null) return;
	const summary = await channels_notifications_db_ensure_summary(ctx, membership);
	const member = "countedMention" in source;
	const field = member ? "mentionChannels" : "recipientUserId" in source ? "unreadInbox" : "unreadThreads";
	const old =
		source.countSummaryId === summary._id &&
		source.countGeneration === summary.generation &&
		(member ? source.countedMention : source.countedUnread);
	const delta = Number(next) - Number(old);
	if (delta) await ctx.db.patch("channels_summaries", summary._id, { [field]: summary[field] + delta });
	const stamp = { countSummaryId: summary._id, countGeneration: summary.generation };
	if (member) await ctx.db.patch("channels_members", source._id, { ...stamp, countedMention: next });
	else if ("recipientUserId" in source)
		await ctx.db.patch("channels_inbox", source._id, { ...stamp, countedUnread: next });
	else await ctx.db.patch("channels_thread_followers", source._id, { ...stamp, countedUnread: next });
}

/**
 * Cleanup must not create a summary for a departed member.
 */
export async function channels_notifications_db_delete_source(ctx: Pick<MutationCtx, "db">, source: CountSource) {
	const summary = source.countSummaryId ? await ctx.db.get("channels_summaries", source.countSummaryId) : null;
	const member = "countedMention" in source;
	const field = member ? "mentionChannels" : "recipientUserId" in source ? "unreadInbox" : "unreadThreads";
	if (
		summary &&
		source.countGeneration === summary.generation &&
		(member ? source.countedMention : source.countedUnread)
	) {
		await ctx.db.patch("channels_summaries", summary._id, { [field]: summary[field] - 1 });
	}
	if (member) await ctx.db.delete("channels_members", source._id);
	else if ("recipientUserId" in source) await ctx.db.delete("channels_inbox", source._id);
	else await ctx.db.delete("channels_thread_followers", source._id);
}

export async function channels_notifications_db_enqueue_sidebar(ctx: WriteContext, channel: Doc<"channels">) {
	const existing = await ctx.db
		.query("channels_sidebar_jobs")
		.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
		.unique();
	if (existing) {
		await ctx.db.patch("channels_sidebar_jobs", existing._id, { requestedRevision: existing.requestedRevision + 1 });
		return;
	}
	const jobId = await ctx.db.insert("channels_sidebar_jobs", {
		channelId: channel._id,
		organizationId: channel.organizationId,
		workspaceId: channel.workspaceId,
		requestedRevision: 1,
		passRevision: 1,
		cursor: null,
		dueAt: Date.now() + channels_notifications_JOB_WATCHDOG_MS,
		scheduledId: null,
	});
	const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_sidebar_job, {
		jobId,
		expectedCursor: null,
		expectedRevision: 1,
	});
	await ctx.db.patch("channels_sidebar_jobs", jobId, { scheduledId });
}

export async function channels_notifications_db_enqueue_thread(ctx: WriteContext, thread: Doc<"channels_threads">) {
	const existing = await ctx.db
		.query("channels_thread_jobs")
		.withIndex("by_thread", (q) => q.eq("threadId", thread._id))
		.unique();
	if (existing) {
		await ctx.db.patch("channels_thread_jobs", existing._id, { requestedRevision: existing.requestedRevision + 1 });
		return;
	}
	const jobId = await ctx.db.insert("channels_thread_jobs", {
		threadId: thread._id,
		channelId: thread.channelId,
		organizationId: thread.organizationId,
		workspaceId: thread.workspaceId,
		requestedRevision: 1,
		passRevision: 1,
		cursor: null,
		dueAt: Date.now() + channels_notifications_JOB_WATCHDOG_MS,
		scheduledId: null,
	});
	const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_thread_job, {
		jobId,
		expectedCursor: null,
		expectedRevision: 1,
	});
	await ctx.db.patch("channels_thread_jobs", jobId, { scheduledId });
}

export async function channels_notifications_db_enqueue_inbox(
	ctx: WriteContext,
	args: Pick<
		Doc<"channels_inbox_jobs">,
		| "workspaceMembershipId"
		| "channelId"
		| "organizationId"
		| "workspaceId"
		| "kind"
		| "rootMessageId"
		| "lowerExclusive"
		| "upperInclusive"
	>,
) {
	if (args.lowerExclusive >= args.upperInclusive) return;
	const jobId = await ctx.db.insert("channels_inbox_jobs", {
		...args,
		cursor: null,
		dueAt: Date.now() + channels_notifications_JOB_WATCHDOG_MS,
		scheduledId: null,
	});
	const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_inbox_job, {
		jobId,
		expectedCursor: null,
	});
	await ctx.db.patch("channels_inbox_jobs", jobId, { scheduledId });
}
