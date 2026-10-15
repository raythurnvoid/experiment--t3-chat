// Shared database bodies. Keep editor and action work on their current owners.

import type { WorkId } from "@convex-dev/workpool";
import type { Infer } from "convex/values";
import type { PaginationOptions } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api.js";
import { files_pending_target_validator } from "./schema.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { activities_db_get_by_source_id, activities_is_active } from "./activities_db.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { r2_enqueue_object_deletion_job } from "./r2_client.ts";
import { convex_error } from "../server/convex-utils.ts";
import { files_TRANSFER_SELECTION_PAGE_SIZE } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

/**
 * Trusted tool reads still check the current chat owner and workspace read access.
 */
export async function ai_chat_files_db_get_door_membership(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		threadId: Id<"ai_chat_threads">;
	},
) {
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_user_organization_workspace_active", (q) =>
			q
				.eq("userId", args.userId)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("active", true),
		)
		.first();
	if (!membership) return Result({ _nay: { message: "Unauthorized" } });
	const thread = await ctx.db.get("ai_chat_threads", args.threadId);
	if (
		!thread ||
		thread.deletingAt !== undefined ||
		thread.copyingAt !== undefined ||
		thread.createdBy !== args.userId ||
		thread.organizationId !== membership.organizationId ||
		thread.workspaceId !== membership.workspaceId
	)
		return Result({ _nay: { message: "Unauthorized" } });
	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: args.userId },
		membership,
		permission: "content.read",
	});
	if (authorized._nay) return authorized;
	return Result({ _yay: membership });
}

export async function ai_chat_files_db_get_invocation_membership(
	ctx: QueryCtx | MutationCtx,
	invocation: Pick<
		Doc<"ai_chat_bash_invocations">,
		"organizationId" | "workspaceId" | "userId" | "threadId" | "membershipId" | "membershipLifetime"
	>,
) {
	const membership = await ctx.db.get("organizations_workspaces_users", invocation.membershipId);
	if (
		!membership?.active ||
		membership.userId !== invocation.userId ||
		membership.organizationId !== invocation.organizationId ||
		membership.workspaceId !== invocation.workspaceId
	)
		return null;
	const lifetime = await organizations_membership_lifetimes_db_get(ctx, invocation);
	if (
		!lifetime?.active ||
		lifetime.membershipId !== invocation.membershipId ||
		lifetime.lifetime !== invocation.membershipLifetime
	)
		return null;
	const user = await ctx.db.get("users", invocation.userId);
	if (!user || user.deletedAt !== undefined) return null;
	const workspace = await ctx.db.get("organizations_workspaces", invocation.workspaceId);
	if (
		!workspace ||
		workspace.organizationId !== invocation.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined
	)
		return null;
	const thread = await ctx.db.get("ai_chat_threads", invocation.threadId);
	if (
		!thread ||
		thread.deletingAt !== undefined ||
		thread.copyingAt !== undefined ||
		thread.createdBy !== invocation.userId ||
		thread.organizationId !== invocation.organizationId ||
		thread.workspaceId !== invocation.workspaceId
	)
		return null;
	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: invocation.userId },
		membership,
		permission: "content.read",
	});
	if (authorized._nay) return null;
	return membership;
}

/**
 * Load a background job row. Callers return quietly on a missing row: purge and the user drain
 * can delete it while a worker, a watchdog or a pool callback is still in flight.
 */
export async function ai_chat_files_db_get_job_row(
	ctx: QueryCtx | MutationCtx,
	invocationId: Id<"ai_chat_bash_invocations">,
) {
	const invocation = await ctx.db.get("ai_chat_bash_invocations", invocationId);
	if (!invocation) return null;
	const job = invocation.job;
	if (!job) throw should_never_happen("Bash invocation is not a background job", { invocationId });
	return { ...invocation, job };
}

export type ai_chat_files_BashJobRow = NonNullable<Awaited<ReturnType<typeof ai_chat_files_db_get_job_row>>>;

export async function ai_chat_files_db_check_bash_job_worker(
	ctx: QueryCtx | MutationCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; workId: WorkId },
) {
	const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
	const job = invocation?.job;
	if (
		!invocation ||
		!job ||
		invocation.status !== "running" ||
		job.stopRequestedAt !== null ||
		job.workId !== args.workId
	)
		return Result({ _nay: { name: "stale_job", message: "This Bash worker is no longer active." } });
	if (!(await ai_chat_files_db_get_invocation_membership(ctx, invocation)))
		return Result({ _nay: { message: "Unauthorized" } });
	const activity = await activities_db_get_by_source_id(ctx, invocation._id);
	if (!activity || !activities_is_active(activity.status) || activity.status === "stopping")
		return Result({ _nay: { name: "stopped", message: "This Bash job has ended or is stopping." } });
	return Result({ _yay: { ...invocation, job } });
}

export async function ai_chat_files_db_retire_bash_job_input(ctx: MutationCtx, invocation: ai_chat_files_BashJobRow) {
	const copy = invocation.job.copy;
	if (copy?.phase !== "admitting") return;
	await r2_enqueue_object_deletion_job(ctx, {
		organizationId: invocation.organizationId,
		workspaceId: invocation.workspaceId,
		r2Key: copy.input.r2Key,
		reason: "bash_input",
		putMayArriveUntil: copy.input.putMayArriveUntil,
		mode: "ensure",
	});
}

/**
 * Checks only. Transfer start uses this before any accepted input is written.
 */
export async function ai_chat_files_db_check_copy_admission(
	ctx: QueryCtx | MutationCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; commandNumber: number; workId: WorkId },
) {
	const checked = await ai_chat_files_db_check_bash_job_worker(ctx, args);
	if (checked._nay) return checked;
	const invocation = checked._yay;
	const checkpoint = invocation.job.copy;
	if (!checkpoint || checkpoint.commandNumber !== args.commandNumber || checkpoint.phase === "delivering")
		return Result({ _nay: { name: "stale_job", message: "This Bash Copy checkpoint is no longer active." } });
	if (checkpoint.phase === "admitting") {
		if (!checkpoint.sealed && !checkpoint.input.ready)
			return Result({ _nay: { name: "incomplete_input", message: "Seal the Bash Copy input before starting Copy." } });
		if (checkpoint.admissionDeadlineAt <= Date.now() || invocation.transferDeadlineAt <= Date.now())
			return Result({ _nay: { name: "timed_out", message: "This Bash Copy admission timed out." } });
	}
	return Result({ _yay: { invocation, checkpoint } });
}

/**
 * Source pages have fixed positions, so one request reads at most two docs.
 */
export async function ai_chat_files_db_check_copy_sources(
	ctx: QueryCtx | MutationCtx,
	args: {
		invocationId: Id<"ai_chat_bash_invocations">;
		commandNumber: number;
		offset: number;
		sources: Infer<typeof files_pending_target_validator>[];
	},
) {
	if (
		!Number.isSafeInteger(args.offset) ||
		args.offset < 0 ||
		args.sources.length < 1 ||
		args.sources.length > files_TRANSFER_SELECTION_PAGE_SIZE
	)
		return Result({ _nay: { name: "invalid_selection", message: "Invalid source page position or size." } });
	const firstPage = Math.floor(args.offset / files_TRANSFER_SELECTION_PAGE_SIZE);
	const lastPage = Math.floor((args.offset + args.sources.length - 1) / files_TRANSFER_SELECTION_PAGE_SIZE);
	const savedSources: Infer<typeof files_pending_target_validator>[] = [];
	for (let page = firstPage; page <= lastPage; page++) {
		const saved = await ctx.db
			.query("ai_chat_bash_job_copy_pages")
			.withIndex("by_invocation_command_page", (q) =>
				q.eq("invocationId", args.invocationId).eq("commandNumber", args.commandNumber).eq("page", page),
			)
			.unique();
		if (!saved)
			return Result({ _nay: { name: "request_changed", message: "Copy sources do not match the saved Bash input." } });
		savedSources.push(...saved.sources);
	}
	const pageOffset = args.offset % files_TRANSFER_SELECTION_PAGE_SIZE;
	const selected = savedSources.slice(pageOffset, pageOffset + args.sources.length);
	if (
		selected.length !== args.sources.length ||
		selected.some((source, index) => source.kind !== args.sources[index]!.kind || source.id !== args.sources[index]!.id)
	)
		return Result({ _nay: { name: "request_changed", message: "Copy sources do not match the saved Bash input." } });
	return Result({ _yay: null });
}

/**
 * Called after run insertion: a refusal must roll back the whole start mutation.
 */
export async function ai_chat_files_db_link_copy_admission(
	ctx: MutationCtx,
	args: {
		invocationId: Id<"ai_chat_bash_invocations">;
		commandNumber: number;
		workId: WorkId;
		runId: Id<"files_transfer_runs">;
	},
) {
	const checked = await ai_chat_files_db_check_copy_admission(ctx, args);
	if (checked._nay) throw convex_error(checked._nay);
	const { invocation, checkpoint } = checked._yay;
	if (checkpoint.runId === args.runId) return null;
	if (checkpoint.phase !== "admitting" || checkpoint.runId !== null)
		throw convex_error({ message: "This Bash Copy checkpoint already belongs to another transfer." });
	await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
		job: { ...invocation.job, copy: { ...checkpoint, runId: args.runId } },
	});
	return null;
}

/**
 * Called inside transfer seal, together with discovery scheduling.
 */
export async function ai_chat_files_db_seal_copy_admission(
	ctx: MutationCtx,
	args: {
		invocationId: Id<"ai_chat_bash_invocations">;
		commandNumber: number;
		workId: WorkId;
		runId: Id<"files_transfer_runs">;
		deadlineAt: number;
		now: number;
	},
) {
	const checked = await ai_chat_files_db_check_copy_admission(ctx, args);
	if (checked._nay) throw convex_error(checked._nay);
	const { invocation, checkpoint } = checked._yay;
	if (checkpoint.runId !== args.runId)
		throw convex_error({ message: "This Bash Copy checkpoint belongs to another transfer." });
	// A lost seal reply must not reset the start of the excluded wait interval.
	if (checkpoint.phase === "waiting") return null;
	if (!checkpoint.sealed) throw convex_error({ message: "Seal the saved Bash input before publishing the transfer." });
	await ai_chat_files_db_retire_bash_job_input(ctx, invocation);
	const activity = await activities_db_get_by_source_id(ctx, invocation._id);
	if (!activity) throw convex_error({ message: "Bash job Activity not found." });
	if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);
	const watchdogId: Id<"_scheduled_functions"> = await ctx.scheduler.runAt(
		args.deadlineAt,
		internal.ai_chat_files.timeout_bash_job,
		{ invocationId: invocation._id, expectedDeadlineAt: args.deadlineAt },
	);
	await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
		deadlineAt: args.deadlineAt,
		job: {
			...invocation.job,
			excludedCopyWaitMs: (invocation.job.excludedCopyWaitMs ?? 0) + Math.max(0, args.now - checkpoint.input.startedAt),
			watchdogId,
			copy: {
				phase: "waiting",
				command: checkpoint.command,
				commandNumber: checkpoint.commandNumber,
				lastArg: checkpoint.lastArg,
				runId: args.runId,
				waitStartedAt: args.now,
			},
		},
	});
	await ctx.db.patch("activities", activity._id, { deadlineAt: args.deadlineAt, updatedAt: args.now });
	return null;
}

export async function ai_chat_files_db_get_bash_transfer(
	ctx: QueryCtx | MutationCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; commandNumber: number },
) {
	return await ctx.db
		.query("ai_chat_bash_invocation_transfers")
		.withIndex("by_invocation_commandNumber", (q) =>
			q.eq("invocationId", args.invocationId).eq("commandNumber", args.commandNumber),
		)
		.first();
}

export async function ai_chat_files_db_list_invocation_transfers(
	ctx: QueryCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; paginationOpts: PaginationOptions },
) {
	const result = await ctx.db
		.query("ai_chat_bash_invocation_transfers")
		.withIndex("by_invocation_commandNumber", (q) => q.eq("invocationId", args.invocationId))
		.paginate({ ...args.paginationOpts, numItems: Math.max(1, Math.min(50, args.paginationOpts.numItems)) });
	return {
		...result,
		page: result.page.map(({ commandNumber, runId, activityId }) => ({ commandNumber, runId, activityId })),
	};
}

/**
 * The producer calls this in the same mutation that accepts the transfer.
 */
export async function ai_chat_files_db_link_bash_transfer(
	ctx: MutationCtx,
	args: {
		invocationId: Id<"ai_chat_bash_invocations">;
		commandNumber: number;
		runId: Id<"files_transfer_runs">;
		activityId: Id<"activities">;
	},
) {
	const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
	if (!invocation || !(await ai_chat_files_db_get_invocation_membership(ctx, invocation)))
		return Result({ _nay: { message: "Unauthorized" } });
	if (!Number.isSafeInteger(args.commandNumber) || args.commandNumber < 0)
		return Result({ _nay: { message: "Invalid Bash command number." } });
	const existing = await ai_chat_files_db_get_bash_transfer(ctx, args);
	if (existing) {
		if (existing.runId !== args.runId || existing.activityId !== args.activityId)
			return Result({
				_nay: { name: "invocation_changed", message: "This Bash command already started another transfer." },
			});
		return Result({ _yay: existing });
	}
	if (invocation.status !== "running" || invocation.deadlineAt <= Date.now())
		return Result({
			_nay: { name: "invocation_interrupted", message: "This Bash call has ended. Start a new command." },
		});
	// A user stop does not change the row status, so the flag is checked on its own.
	if (invocation.job && invocation.job.stopRequestedAt !== null)
		return Result({ _nay: { name: "stopped", message: "This job is stopping. No new transfer can start." } });
	const link = {
		...args,
		organizationId: invocation.organizationId,
		workspaceId: invocation.workspaceId,
		threadId: invocation.threadId,
	};
	const id = await ctx.db.insert("ai_chat_bash_invocation_transfers", link);
	return Result({ _yay: (await ctx.db.get("ai_chat_bash_invocation_transfers", id))! });
}
