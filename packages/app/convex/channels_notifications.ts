import { v } from "convex/values";
import { query, type MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation } from "./functions.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { convex_error } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import {
	channels_notifications_JOB_WATCHDOG_MS,
	channels_notifications_authority_matches,
	channels_notifications_db_get_scope,
	channels_notifications_db_get_authority_pins,
	channels_notifications_db_has_sources,
	channels_notifications_db_ensure_summary,
	channels_notifications_db_start_repair,
} from "../server/channels-notifications.ts";
import { channels_db_reconcile_member } from "./channels.ts";
import { channels_messages_db_reconcile_follower, channels_messages_db_reconcile_inbox } from "./channels_messages.ts";

export const experimental_reuseContext = true;
const BATCH_SIZE = 50;

export const get_summary = query({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.union(
		v.null(),
		v.object({ state: v.literal("updating"), accessScopeKey: v.string() }),
		v.object({
			state: v.literal("delayed"),
			accessScopeKey: v.string(),
			mentionChannels: v.number(),
			unreadInbox: v.number(),
			unreadThreads: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
		if (!userAuth || !user || user.deletedAt != null) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			membershipId: args.membershipId,
			userId: userAuth.id,
		});
		if (!membership) return null;
		const { pins, summary, accessScopeKey } = await channels_notifications_db_get_scope(ctx, membership);
		if (!summary)
			return (await channels_notifications_db_has_sources(ctx.db, membership._id))
				? { state: "updating" as const, accessScopeKey }
				: { state: "delayed" as const, accessScopeKey, mentionChannels: 0, unreadInbox: 0, unreadThreads: 0 };
		if (!summary.ready || !channels_notifications_authority_matches(summary, pins))
			return { state: "updating" as const, accessScopeKey };
		return {
			state: "delayed" as const,
			accessScopeKey,
			mentionChannels: summary.mentionChannels,
			unreadInbox: summary.unreadInbox,
			unreadThreads: summary.unreadThreads,
		};
	},
});

export const repair_summary = internalMutation({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
		if (!membership?.active) return null;
		const user = await ctx.db.get("users", membership.userId);
		if (!user || user.deletedAt != null) return null;
		const summary = await channels_notifications_db_ensure_summary(ctx, membership);
		await channels_notifications_db_start_repair(ctx, summary);
		return null;
	},
});

export const drain_sidebar_job = internalMutation({
	args: {
		jobId: v.id("channels_sidebar_jobs"),
		expectedCursor: v.optional(v.union(v.string(), v.null())),
		expectedRevision: v.optional(v.number()),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = await ctx.db.get("channels_sidebar_jobs", args.jobId);
		if (
			!job ||
			(args.expectedCursor !== undefined && job.cursor !== args.expectedCursor) ||
			(args.expectedRevision !== undefined && job.passRevision !== args.expectedRevision)
		)
			return null;
		const page = await ctx.db
			.query("channels_members")
			.withIndex("by_channel_user", (q) => q.eq("channelId", job.channelId))
			.paginate({ cursor: job.cursor, numItems: args._test_batchSize ?? BATCH_SIZE });
		for (const member of page.page) await channels_db_reconcile_member(ctx, member);
		if (page.isDone && job.requestedRevision === job.passRevision) {
			await ctx.db.delete("channels_sidebar_jobs", job._id);
			return null;
		}
		const cursor = page.isDone ? null : page.continueCursor;
		const passRevision = page.isDone ? job.requestedRevision : job.passRevision;
		const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_sidebar_job, {
			jobId: job._id,
			expectedCursor: cursor,
			expectedRevision: passRevision,
			_test_batchSize: args._test_batchSize,
		});
		await ctx.db.patch("channels_sidebar_jobs", job._id, {
			cursor,
			passRevision,
			scheduledId,
			dueAt: Date.now() + channels_notifications_JOB_WATCHDOG_MS,
		});
		return null;
	},
});

export const drain_thread_job = internalMutation({
	args: {
		jobId: v.id("channels_thread_jobs"),
		expectedCursor: v.optional(v.union(v.string(), v.null())),
		expectedRevision: v.optional(v.number()),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = await ctx.db.get("channels_thread_jobs", args.jobId);
		if (
			!job ||
			(args.expectedCursor !== undefined && job.cursor !== args.expectedCursor) ||
			(args.expectedRevision !== undefined && job.passRevision !== args.expectedRevision)
		)
			return null;
		const page = await ctx.db
			.query("channels_thread_followers")
			.withIndex("by_thread", (q) => q.eq("threadId", job.threadId))
			.paginate({ cursor: job.cursor, numItems: args._test_batchSize ?? BATCH_SIZE });
		for (const follower of page.page) await channels_messages_db_reconcile_follower(ctx, follower);
		if (page.isDone && job.requestedRevision === job.passRevision) {
			await ctx.db.delete("channels_thread_jobs", job._id);
			return null;
		}
		const cursor = page.isDone ? null : page.continueCursor;
		const passRevision = page.isDone ? job.requestedRevision : job.passRevision;
		const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_thread_job, {
			jobId: job._id,
			expectedCursor: cursor,
			expectedRevision: passRevision,
			_test_batchSize: args._test_batchSize,
		});
		await ctx.db.patch("channels_thread_jobs", job._id, {
			cursor,
			passRevision,
			scheduledId,
			dueAt: Date.now() + channels_notifications_JOB_WATCHDOG_MS,
		});
		return null;
	},
});

export const drain_inbox_job = internalMutation({
	args: {
		jobId: v.id("channels_inbox_jobs"),
		expectedCursor: v.optional(v.union(v.string(), v.null())),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = await ctx.db.get("channels_inbox_jobs", args.jobId);
		if (!job || (args.expectedCursor !== undefined && job.cursor !== args.expectedCursor)) return null;
		const range =
			job.kind === "main"
				? ctx.db
						.query("channels_inbox")
						.withIndex("by_m_channel_mainSequence", (q) =>
							q
								.eq("workspaceMembershipId", job.workspaceMembershipId)
								.eq("channelId", job.channelId)
								.gt("mainSequence", job.lowerExclusive)
								.lte("mainSequence", job.upperInclusive),
						)
				: ctx.db
						.query("channels_inbox")
						.withIndex("by_m_root_threadSequence", (q) =>
							q
								.eq("workspaceMembershipId", job.workspaceMembershipId)
								.eq("threadRootId", job.rootMessageId)
								.gt("threadSequence", job.lowerExclusive)
								.lte("threadSequence", job.upperInclusive),
						);
		const page = await range.paginate({ cursor: job.cursor, numItems: args._test_batchSize ?? BATCH_SIZE });
		for (const item of page.page) await channels_messages_db_reconcile_inbox(ctx, item);
		if (page.isDone) await ctx.db.delete("channels_inbox_jobs", job._id);
		else {
			const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_inbox_job, {
				jobId: job._id,
				expectedCursor: page.continueCursor,
				_test_batchSize: args._test_batchSize,
			});
			await ctx.db.patch("channels_inbox_jobs", job._id, {
				cursor: page.continueCursor,
				scheduledId,
				dueAt: Date.now() + channels_notifications_JOB_WATCHDOG_MS,
			});
		}
		return null;
	},
});

export const drain_summary_job = internalMutation({
	args: {
		jobId: v.id("channels_summary_jobs"),
		expectedCursor: v.optional(v.union(v.string(), v.null())),
		expectedPhase: v.optional(v.union(v.literal("members"), v.literal("inbox"), v.literal("followers"))),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = await ctx.db.get("channels_summary_jobs", args.jobId);
		if (
			!job ||
			(args.expectedCursor !== undefined && job.cursor !== args.expectedCursor) ||
			(args.expectedPhase !== undefined && job.phase !== args.expectedPhase)
		)
			return null;
		const membership = await ctx.db.get("organizations_workspaces_users", job.workspaceMembershipId);
		const summary = await ctx.db.get("channels_summaries", job.summaryId);
		const user = membership ? await ctx.db.get("users", membership.userId) : null;
		if (
			!membership?.active ||
			!user ||
			user.deletedAt != null ||
			!summary ||
			summary.workspaceMembershipId !== job.workspaceMembershipId ||
			summary.generation !== job.generation
		) {
			await ctx.db.delete("channels_summary_jobs", job._id);
			return null;
		}
		const pins = await channels_notifications_db_get_authority_pins(ctx.db, summary);
		if (!channels_notifications_authority_matches(summary, pins)) {
			await channels_notifications_db_start_repair(ctx, summary);
			return null;
		}
		const options = { cursor: job.cursor, numItems: args._test_batchSize ?? BATCH_SIZE };
		let page: { isDone: boolean; continueCursor: string };
		if (job.phase === "members") {
			const members = await ctx.db
				.query("channels_members")
				.withIndex("by_workspaceMembership_channelKind_channel", (q) => q.eq("workspaceMembershipId", membership._id))
				.paginate(options);
			for (const member of members.page) await channels_db_reconcile_member(ctx, member);
			page = members;
		} else if (job.phase === "inbox") {
			const inbox = await ctx.db
				.query("channels_inbox")
				.withIndex("by_workspaceMembership_createdAt", (q) => q.eq("workspaceMembershipId", membership._id))
				.paginate(options);
			for (const item of inbox.page) await channels_messages_db_reconcile_inbox(ctx, item);
			page = inbox;
		} else {
			const followers = await ctx.db
				.query("channels_thread_followers")
				.withIndex("by_workspaceMembership_thread", (q) => q.eq("workspaceMembershipId", membership._id))
				.paginate(options);
			for (const follower of followers.page) await channels_messages_db_reconcile_follower(ctx, follower);
			page = followers;
		}
		if (page.isDone && job.phase === "followers") {
			const current = (await ctx.db.get("channels_summaries", summary._id))!;
			const currentPins = await channels_notifications_db_get_authority_pins(ctx.db, current);
			if (current.generation !== job.generation) return null;
			if (!channels_notifications_authority_matches(current, currentPins))
				await channels_notifications_db_start_repair(ctx, current);
			else {
				await ctx.db.patch("channels_summaries", current._id, { ready: true });
				await ctx.db.delete("channels_summary_jobs", job._id);
			}
			return null;
		}
		const phase = page.isDone ? (job.phase === "members" ? "inbox" : "followers") : job.phase;
		const cursor = page.isDone ? null : page.continueCursor;
		const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_summary_job, {
			jobId: job._id,
			expectedCursor: cursor,
			expectedPhase: phase,
			_test_batchSize: args._test_batchSize,
		});
		await ctx.db.patch("channels_summary_jobs", job._id, {
			phase,
			cursor,
			scheduledId,
			dueAt: Date.now() + channels_notifications_JOB_WATCHDOG_MS,
		});
		return null;
	},
});

export const drain_authority_job = internalMutation({
	args: {
		jobId: v.id("channels_authority_jobs"),
		expectedCursor: v.optional(v.union(v.string(), v.null())),
		expectedRevision: v.optional(v.number()),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = await ctx.db.get("channels_authority_jobs", args.jobId);
		if (
			!job ||
			(args.expectedCursor !== undefined && job.cursor !== args.expectedCursor) ||
			(args.expectedRevision !== undefined && job.passRevision !== args.expectedRevision)
		)
			return null;
		const page = await ctx.db
			.query("channels_summaries")
			.withIndex("by_organization_workspace_membership", (q) => {
				const organization = q.eq("organizationId", job.organizationId);
				return job.workspaceId === null ? organization : organization.eq("workspaceId", job.workspaceId);
			})
			.paginate({ cursor: job.cursor, numItems: args._test_batchSize ?? BATCH_SIZE });
		for (const summary of page.page) {
			const membership = await ctx.db.get("organizations_workspaces_users", summary.workspaceMembershipId);
			const user = membership ? await ctx.db.get("users", membership.userId) : null;
			if (membership?.active && user && user.deletedAt == null)
				await channels_notifications_db_ensure_summary(ctx, membership);
		}
		if (page.isDone && job.requestedRevision === job.passRevision)
			await ctx.db.delete("channels_authority_jobs", job._id);
		else {
			const cursor = page.isDone ? null : page.continueCursor;
			const passRevision = page.isDone ? job.requestedRevision : job.passRevision;
			const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_authority_job, {
				jobId: job._id,
				expectedCursor: cursor,
				expectedRevision: passRevision,
				_test_batchSize: args._test_batchSize,
			});
			await ctx.db.patch("channels_authority_jobs", job._id, {
				cursor,
				passRevision,
				scheduledId,
				dueAt: Date.now() + channels_notifications_JOB_WATCHDOG_MS,
			});
		}
		return null;
	},
});

const job_kind_validator = v.union(
	v.literal("sidebar"),
	v.literal("thread"),
	v.literal("inbox"),
	v.literal("summary"),
	v.literal("authority"),
);
const JOB_KINDS = ["sidebar", "thread", "inbox", "summary", "authority"] as const;

export const retry_due_jobs = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await ctx.scheduler.runAfter(0, internal.channels_notifications.recover_jobs_page, {
			kind: "sidebar",
			cutoff: Date.now(),
			cursor: null,
		});
		return null;
	},
});

async function retry_job(ctx: MutationCtx, kind: (typeof JOB_KINDS)[number], id: string) {
	const dueAt = Date.now() + channels_notifications_JOB_WATCHDOG_MS;
	if (kind === "sidebar") {
		const job = (await ctx.db.get("channels_sidebar_jobs", id as Id<"channels_sidebar_jobs">))!;
		const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_sidebar_job, {
			jobId: job._id,
			expectedCursor: job.cursor,
			expectedRevision: job.passRevision,
		});
		await ctx.db.patch("channels_sidebar_jobs", job._id, { scheduledId, dueAt });
	} else if (kind === "thread") {
		const job = (await ctx.db.get("channels_thread_jobs", id as Id<"channels_thread_jobs">))!;
		const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_thread_job, {
			jobId: job._id,
			expectedCursor: job.cursor,
			expectedRevision: job.passRevision,
		});
		await ctx.db.patch("channels_thread_jobs", job._id, { scheduledId, dueAt });
	} else if (kind === "inbox") {
		const job = (await ctx.db.get("channels_inbox_jobs", id as Id<"channels_inbox_jobs">))!;
		const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_inbox_job, {
			jobId: job._id,
			expectedCursor: job.cursor,
		});
		await ctx.db.patch("channels_inbox_jobs", job._id, { scheduledId, dueAt });
	} else if (kind === "summary") {
		const job = (await ctx.db.get("channels_summary_jobs", id as Id<"channels_summary_jobs">))!;
		const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_summary_job, {
			jobId: job._id,
			expectedCursor: job.cursor,
			expectedPhase: job.phase,
		});
		await ctx.db.patch("channels_summary_jobs", job._id, { scheduledId, dueAt });
	} else {
		const job = (await ctx.db.get("channels_authority_jobs", id as Id<"channels_authority_jobs">))!;
		const scheduledId = await ctx.scheduler.runAfter(0, internal.channels_notifications.drain_authority_job, {
			jobId: job._id,
			expectedCursor: job.cursor,
			expectedRevision: job.passRevision,
		});
		await ctx.db.patch("channels_authority_jobs", job._id, { scheduledId, dueAt });
	}
}

export const recover_jobs_page = internalMutation({
	args: {
		kind: job_kind_validator,
		cutoff: v.number(),
		cursor: v.union(v.string(), v.null()),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const table = `channels_${args.kind}_jobs` as const;
		const page = await ctx.db
			.query(table)
			.withIndex("by_dueAt", (q) => q.lte("dueAt", args.cutoff))
			.paginate({ cursor: args.cursor, numItems: args._test_batchSize ?? BATCH_SIZE });
		for (const job of page.page) {
			const scheduled = job.scheduledId ? await ctx.db.system.get(job.scheduledId) : null;
			if (scheduled?.state.kind === "pending" || scheduled?.state.kind === "inProgress") continue;
			if (scheduled?.state.kind === "failed")
				console.error("Retrying Messages job", {
					kind: args.kind,
					jobId: job._id,
					organizationId: job.organizationId,
					workspaceId: job.workspaceId,
					phase: "phase" in job ? job.phase : null,
					hasCursor: job.cursor !== null,
					error: "Scheduled mutation failed",
				});
			await retry_job(ctx, args.kind, job._id);
		}
		const nextKind = page.isDone ? JOB_KINDS[JOB_KINDS.indexOf(args.kind) + 1] : args.kind;
		if (nextKind)
			await ctx.scheduler.runAfter(0, internal.channels_notifications.recover_jobs_page, {
				kind: nextKind,
				cutoff: args.cutoff,
				cursor: page.isDone ? null : page.continueCursor,
				_test_batchSize: args._test_batchSize,
			});
		return null;
	},
});
