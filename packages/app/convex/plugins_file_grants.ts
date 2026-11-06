import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import { access_control_create_file_checker } from "./access_control.ts";
import { plugins_file_grants_db_retire_anchor } from "./plugins_file_grants_cleanup.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import {
	plugins_file_grants_db_get_authority_pins,
	plugins_file_grants_db_schedule,
	plugins_file_grants_db_validate_pair,
} from "../server/plugins-file-grants.ts";

type GrantJob = Doc<"plugins_file_grant_jobs">;

function pins_match(job: GrantJob, pins: Pick<GrantJob, "organizationAuthorityPin" | "workspaceAuthorityPin">) {
	return (
		job.organizationAuthorityPin?.id === pins.organizationAuthorityPin?.id &&
		job.organizationAuthorityPin?.revision === pins.organizationAuthorityPin?.revision &&
		job.workspaceAuthorityPin?.id === pins.workspaceAuthorityPin?.id &&
		job.workspaceAuthorityPin?.revision === pins.workspaceAuthorityPin?.revision
	);
}

async function db_check_root(
	ctx: MutationCtx,
	consent: Doc<"plugins_file_consents">,
	permission: "content.read" | "content.write",
) {
	const pair = await plugins_file_grants_db_validate_pair(ctx, { pairId: consent.pairId });
	const root = consent.rootNodeId !== null ? await files_saved_placement_db_get_node(ctx.db, consent.rootNodeId) : null;
	if (
		!pair ||
		pair.organizationId !== consent.organizationId ||
		pair.workspaceId !== consent.workspaceId ||
		(consent.rootNodeId !== null &&
			(!root || root.organizationId !== consent.organizationId || root.workspaceId !== consent.workspaceId))
	)
		return false;
	return await access_control_create_file_checker(ctx, {
		organizationId: consent.organizationId,
		workspaceId: consent.workspaceId,
		subject: { kind: "user", userId: pair.userId, plugin: null },
	}).can(root, permission);
}

async function db_finish_consent(ctx: MutationCtx, job: GrantJob) {
	await ctx.db.patch("plugins_file_grant_jobs", job._id, {
		phase: "next",
		consentId: null,
		consentRevision: null,
		readAllowed: null,
		writeAllowed: null,
		organizationAuthorityPin: null,
		workspaceAuthorityPin: null,
	});
	await plugins_file_grants_db_schedule(ctx, { ...job, phase: "next" });
}

export const advance = internalMutation({
	args: {
		jobId: v.id("plugins_file_grant_jobs"),
		step: v.number(),
		phase: v.union(v.literal("next"), v.literal("read"), v.literal("write"), v.literal("apply")),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = await ctx.db.get("plugins_file_grant_jobs", args.jobId);
		if (!job || job.step !== args.step || job.phase !== args.phase || !job.scheduledId) return null;
		const scheduled = await ctx.db.system.get(job.scheduledId);
		// The step names this scheduled job, including after watchdog recovery.
		const scheduledArgs = scheduled?.args[0];
		if (
			!scheduledArgs ||
			typeof scheduledArgs !== "object" ||
			!("jobId" in scheduledArgs) ||
			scheduledArgs.jobId !== job._id ||
			!("step" in scheduledArgs) ||
			scheduledArgs.step !== args.step ||
			!("phase" in scheduledArgs) ||
			scheduledArgs.phase !== args.phase
		)
			return null;
		const organization = await ctx.db.get("organizations", job.organizationId);
		const workspace = job.workspaceId ? await ctx.db.get("organizations_workspaces", job.workspaceId) : null;
		if (
			!organization ||
			(job.workspaceId &&
				(!workspace ||
					workspace.organizationId !== job.organizationId ||
					workspace.pluginDataPurgeStartedAt !== undefined))
		) {
			await ctx.db.delete("plugins_file_grant_jobs", job._id);
			return null;
		}
		if (job.phase === "next") {
			if (job.passDone) {
				const clock = await ctx.db
					.query("plugins_file_authority_versions")
					.withIndex("by_organization_workspace", (q) =>
						q.eq("organizationId", job.organizationId).eq("workspaceId", job.workspaceId),
					)
					.first();
				const requestedRevision = Math.max(job.requestedRevision, clock?.revision ?? 0);
				if (requestedRevision === job.passRevision) {
					await ctx.db.delete("plugins_file_grant_jobs", job._id);
					return null;
				}
				await ctx.db.patch("plugins_file_grant_jobs", job._id, {
					requestedRevision,
					passRevision: requestedRevision,
					passDone: false,
					cursor: null,
				});
				await plugins_file_grants_db_schedule(ctx, job);
				return null;
			}
			const query =
				job.workspaceId === null
					? ctx.db
							.query("plugins_file_consents")
							.withIndex("by_organization_open_workspace", (q) =>
								q.eq("organizationId", job.organizationId).eq("open", true),
							)
					: ctx.db
							.query("plugins_file_consents")
							.withIndex("by_organization_workspace_open", (q) =>
								q.eq("organizationId", job.organizationId).eq("workspaceId", job.workspaceId!).eq("open", true),
							);
			// A human permission check owns its next transaction, even for a deep selected root.
			const page = await query.paginate({ cursor: job.cursor, numItems: 1 });
			const consent = page.page[0];
			const phase = consent ? "read" : "next";
			await ctx.db.patch("plugins_file_grant_jobs", job._id, {
				cursor: page.continueCursor,
				passDone: page.isDone,
				phase,
				consentId: consent?._id ?? null,
				consentRevision: consent?.revision ?? null,
			});
			await plugins_file_grants_db_schedule(ctx, { ...job, phase });
			return null;
		}
		const consent = job.consentId ? await ctx.db.get("plugins_file_consents", job.consentId) : null;
		if (!consent?.open) {
			await db_finish_consent(ctx, job);
			return null;
		}
		const pins = await plugins_file_grants_db_get_authority_pins(ctx.db, consent);
		if (job.phase === "read") {
			const readAllowed = await db_check_root(ctx, consent, "content.read");
			const phase = readAllowed && consent.requestedLevel === "write" ? "write" : "apply";
			await ctx.db.patch("plugins_file_grant_jobs", job._id, {
				...pins,
				consentRevision: consent.revision,
				readAllowed,
				writeAllowed: false,
				phase,
			});
			await plugins_file_grants_db_schedule(ctx, { ...job, phase });
			return null;
		}
		if (consent.revision !== job.consentRevision || !pins_match(job, pins)) {
			await ctx.db.patch("plugins_file_grant_jobs", job._id, { phase: "read" });
			await plugins_file_grants_db_schedule(ctx, { ...job, phase: "read" });
			return null;
		}
		if (job.phase === "write") {
			const writeAllowed = await db_check_root(ctx, consent, "content.write");
			await ctx.db.patch("plugins_file_grant_jobs", job._id, { writeAllowed, phase: "apply" });
			await plugins_file_grants_db_schedule(ctx, { ...job, phase: "apply" });
			return null;
		}
		const pair = await plugins_file_grants_db_validate_pair(ctx, { pairId: consent.pairId });
		const root =
			consent.rootNodeId !== null ? await files_saved_placement_db_get_node(ctx.db, consent.rootNodeId) : null;
		const readAllowed =
			job.readAllowed &&
			pair &&
			pair.organizationId === consent.organizationId &&
			pair.workspaceId === consent.workspaceId &&
			(consent.rootNodeId === null ||
				(root && root.organizationId === consent.organizationId && root.workspaceId === consent.workspaceId));
		await ctx.db.patch(
			"plugins_file_consents",
			consent._id,
			readAllowed
				? {
						appliedLevel: consent.requestedLevel === "write" && job.writeAllowed ? "write" : "read",
						areaEligible:
							consent.rootNodeId === null ||
							(root?.kind === "folder" && root.isRestrictedScopeRoot && root.archiveOperationId === null),
						state: "applied",
						endedReason: null,
						updatedAt: Date.now(),
					}
				: {
						appliedLevel: null,
						areaEligible: false,
						open: false,
						state: "ended",
						endedReason: "You no longer have access to this item. Grant access again to use it.",
						updatedAt: Date.now(),
					},
		);
		if (!readAllowed) {
			const previousPair = pair ?? (await ctx.db.get("plugins_file_pairs", consent.pairId));
			if (previousPair && consent.rootNodeId !== null)
				await plugins_file_grants_db_retire_anchor(ctx, { nodeId: consent.rootNodeId, userId: previousPair.userId });
		}
		await db_finish_consent(ctx, job);
		return null;
	},
});

export const recover_due = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())), cutoff: v.optional(v.number()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const cutoff = args.cutoff ?? Date.now();
		const page = await ctx.db
			.query("plugins_file_grant_jobs")
			.withIndex("by_dueAt", (q) => q.lte("dueAt", cutoff))
			.paginate({ cursor: args.cursor ?? null, numItems: 50 });
		for (const job of page.page) {
			const scheduled = job.scheduledId ? await ctx.db.system.get(job.scheduledId) : null;
			if (scheduled?.state.kind === "pending" || scheduled?.state.kind === "inProgress") continue;
			if (scheduled?.state.kind === "failed")
				console.error("Retrying plugin file access update", { jobId: job._id, phase: job.phase });
			await plugins_file_grants_db_schedule(ctx, job);
		}
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.plugins_file_grants.recover_due, {
				cutoff,
				cursor: page.continueCursor,
			});
		return null;
	},
});
