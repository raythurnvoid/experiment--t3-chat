// Temporary native Move controls. Remove this module with the page proof hooks.
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalQuery, type MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { access_control_db_authorize_membership, access_control_db_authorize_node } from "./access_control.ts";
import { activities_db_get_by_source_id, activities_is_active } from "./activities_db.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { files_move_cohorts_db_advance, files_move_cohorts_db_schedule } from "./files_move_cohorts.ts";
import { files_pending_overlay_db_page_proof_rollback } from "../server/files-pending-overlay.ts";

const ORGANIZATION_ID = "gs7pjc3hzy2m10e1hj3vk0kzad8cm7tb" as Id<"organizations">;
const WORKSPACE_ID = "h57vccrf1r4j9q6ky0etf6v0gx8cm2kw" as Id<"organizations_workspaces">;
const USER_ID = "m577heygr826f2wgk6r30mk1vd8928q2" as Id<"users">;
const MEMBERSHIP_ID = "h97xwdwwy689rs2hj7cxnwbq0s8cma56" as Id<"organizations_workspaces_users">;
const SOURCE_ID = "v97er5hkawd92x0g1xjgnb5yg18fq5hj" as Id<"files_nodes">;
const TARGET_ID = "v97fw6s946y7vpk3t1wzw3n5z98fpg1p" as Id<"files_nodes">;
const SOURCE_PATH = "/qa-profile-20261005-folder-b";
const TARGET_PATH = "/qa-profile-20261005-folder-a";

async function db_check(
	ctx: MutationCtx,
	args: {
		runId: Id<"files_transfer_runs">;
		cohortId: Id<"files_move_cohorts">;
		step: number;
		runGeneration: number;
	},
) {
	const [cohort, run] = await Promise.all([
		ctx.db.get("files_move_cohorts", args.cohortId),
		ctx.db.get("files_transfer_runs", args.runId),
	]);
	if (
		!cohort || !run ||
		cohort.organizationId !== ORGANIZATION_ID || cohort.workspaceId !== WORKSPACE_ID ||
		cohort.userId !== USER_ID || cohort.membershipId !== MEMBERSHIP_ID ||
		cohort.origin.kind !== "transfer" || cohort.origin.runId !== run._id ||
		cohort.publishedAt !== null || cohort.visibleView !== "before" ||
		cohort.phase === "complete" || cohort.phase === "aborting" ||
		cohort.step !== args.step || !cohort.runJob || cohort.runJob.generation !== args.runGeneration ||
		cohort.runJob.step !== cohort.step || cohort.deadlineAt <= Date.now() ||
		cohort.itemCount !== 1 ||
		run.organizationId !== ORGANIZATION_ID || run.workspaceId !== WORKSPACE_ID ||
		run.userId !== USER_ID || run.kind !== "move" || run.origin.kind !== "clipboard" ||
		run.sourceView !== "saved" || run.publication !== "saved" ||
		!run.selection || run.selection.expectedCount !== 1 || run.selection.count !== 1 ||
		run.revision !== cohort.fence
	) throw new Error("MOVE_PAGE_PROOF_SETUP_SCOPE_OR_TUPLE");
	for (const scope of [run.sourceScope, run.destinationScope]) {
		if (
			scope.organizationId !== ORGANIZATION_ID || scope.workspaceId !== WORKSPACE_ID ||
			scope.membershipId !== MEMBERSHIP_ID || scope.membershipLifetime !== cohort.membershipLifetime
		) throw new Error("MOVE_PAGE_PROOF_SETUP_TRANSFER_SCOPE");
	}
	const targetParentId = run.targetParent.kind === "root"
		? "root"
		: run.targetParent.kind === "saved" && run.targetParent.id === TARGET_ID ? TARGET_ID : null;
	if (!targetParentId || run.targetPath !== (targetParentId === "root" ? "/" : TARGET_PATH))
		throw new Error("MOVE_PAGE_PROOF_SETUP_DESTINATION");

	const [item, source, target, membership, lifetime, activity] = await Promise.all([
		ctx.db.get("files_transfer_items", cohort.origin.itemId),
		ctx.db.get("files_nodes", SOURCE_ID),
		ctx.db.get("files_nodes", TARGET_ID),
		ctx.db.get("organizations_workspaces_users", MEMBERSHIP_ID),
		organizations_membership_lifetimes_db_get(ctx, { workspaceId: WORKSPACE_ID, userId: USER_ID }),
		activities_db_get_by_source_id(ctx, run._id),
	]);
	if (
		!item || item.runId !== run._id || item.state !== "pending" ||
		item.attempt !== cohort.attemptFence || item.source.kind !== "saved" || item.source.id !== SOURCE_ID ||
		!source || source.organizationId !== ORGANIZATION_ID || source.workspaceId !== WORKSPACE_ID ||
		source.kind !== "folder" || source.archiveOperationId !== null ||
		(source.parentId !== "root" && source.parentId !== TARGET_ID) ||
		source.path !== (source.parentId === "root" ? SOURCE_PATH : TARGET_PATH + SOURCE_PATH) ||
		source.parentId === targetParentId ||
		!target || target.organizationId !== ORGANIZATION_ID || target.workspaceId !== WORKSPACE_ID ||
		target.kind !== "folder" || target.parentId !== "root" || target.path !== TARGET_PATH ||
		target.archiveOperationId !== null ||
		!membership || !membership.active || membership.userId !== USER_ID ||
		membership.organizationId !== ORGANIZATION_ID || membership.workspaceId !== WORKSPACE_ID ||
		!lifetime?.active || lifetime.membershipId !== MEMBERSHIP_ID ||
		lifetime.lifetime !== cohort.membershipLifetime ||
		!activity || !activities_is_active(activity.status) || activity.status === "stopping" ||
		activity.deadlineAt <= Date.now()
	) throw new Error("MOVE_PAGE_PROOF_SETUP_FIXTURE_OR_PARENT");
	const allowed = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: USER_ID }, membership, permission: "content.write",
	});
	if (allowed._nay) throw new Error("MOVE_PAGE_PROOF_SETUP_PERMISSION");
	const writable = await access_control_db_authorize_node(ctx, {
		userAuth: { id: USER_ID }, membership, nodeId: SOURCE_ID, permission: "content.write",
	});
	if (writable._nay) throw new Error("MOVE_PAGE_PROOF_SETUP_PERMISSION");
	return cohort;
}

async function db_pending_job(ctx: MutationCtx, cohort: Doc<"files_move_cohorts">) {
	const owner = cohort.runJob;
	if (!owner || owner.step !== cohort.step) throw new Error("MOVE_PAGE_PROOF_SETUP_OWNER");
	const job = await ctx.db.system.get(owner.id);
	const jobArgs: unknown = job?.args[0];
	const serverNow = Date.now();
	if (
		!job || job.name !== "files_move_run:run" || job.state.kind !== "pending" ||
		job.args.length !== 1 || job.scheduledTime - serverNow < 30_000 ||
		typeof jobArgs !== "object" || jobArgs === null ||
		!("cohortId" in jobArgs) || jobArgs.cohortId !== cohort._id ||
		!("step" in jobArgs) || jobArgs.step !== cohort.step ||
		!("runGeneration" in jobArgs) || jobArgs.runGeneration !== owner.generation ||
		!("mode" in jobArgs) || jobArgs.mode !== "chain"
	) throw new Error("MOVE_PAGE_PROOF_SETUP_JOB_WINDOW");
	return { owner, job, serverNow };
}

export const arm = internalMutation({
	args: {
		runId: v.id("files_transfer_runs"), cohortId: v.id("files_move_cohorts"),
		runGeneration: v.number(),
	},
	returns: v.object({
		runId: v.id("files_transfer_runs"), cohortId: v.id("files_move_cohorts"),
		step: v.number(), runGeneration: v.number(), jobId: v.id("_scheduled_functions"),
		serverNow: v.number(), scheduledTime: v.number(),
	}),
	handler: async (ctx, args) => {
		const current = await ctx.db.get("files_move_cohorts", args.cohortId);
		if (!current) throw new Error("MOVE_PAGE_PROOF_SETUP_SCOPE_OR_TUPLE");
		const cohort = await db_check(ctx, { ...args, step: current.step });
		// Keep the proof window inside the normal two-minute recovery delay.
		if (Date.now() - cohort.operationTime > 30_000)
			throw new Error("MOVE_PAGE_PROOF_SETUP_COHORT_AGE");
		await files_move_cohorts_db_schedule(ctx, { cohortId: cohort._id, handoff: true, delayMs: 60_000 });
		const armed = await ctx.db.get("files_move_cohorts", cohort._id);
		if (!armed) throw new Error("MOVE_PAGE_PROOF_SETUP_OWNER");
		const { owner, job, serverNow } = await db_pending_job(ctx, armed);
		return {
			runId: args.runId, cohortId: armed._id, step: armed.step,
			runGeneration: owner.generation, jobId: job._id, serverNow, scheduledTime: job.scheduledTime,
		};
	},
});

export const rollback_two_pages = internalMutation({
	args: {
		runId: v.id("files_transfer_runs"), cohortId: v.id("files_move_cohorts"),
		step: v.number(), runGeneration: v.number(), seedSchedule: v.boolean(), staleDrain: v.boolean(),
	},
	returns: v.null(),
	handler: async (ctx, args): Promise<never> => {
		const cohort = await db_check(ctx, args);
		const { owner } = await db_pending_job(ctx, cohort);
		files_pending_overlay_db_page_proof_rollback(ctx, cohort._id, args.staleDrain);
		if (args.seedSchedule) {
			// Only this new job is canceled. The final throw rolls both operations back.
			const seeded = await ctx.scheduler.runAfter(60_000, internal.files_move_cohorts.advance, {
				cohortId: cohort._id, step: cohort.step, runGeneration: owner.generation, join: false,
			});
			await ctx.scheduler.cancel(seeded);
		}
		await files_move_cohorts_db_advance(ctx, {
			cohortId: cohort._id, step: cohort.step, runGeneration: owner.generation, join: true,
		}, 16);
		// The root hook must throw after two real page/write units. Never commit a short attempt.
		throw new Error("MOVE_PAGE_PROOF_SETUP_ENGINE_RETURNED_BEFORE_TWO_UNITS");
	},
});

export const direct_native_two_pages = internalQuery({
	args: {},
	returns: v.null(),
	handler: async (ctx): Promise<never> => {
		const source = await ctx.db.get("files_nodes", SOURCE_ID);
		if (
			!source || source.organizationId !== ORGANIZATION_ID || source.workspaceId !== WORKSPACE_ID ||
			source.kind !== "folder" || source.archiveOperationId !== null || source.moveCohortId !== undefined ||
			(source.parentId !== "root" && source.parentId !== TARGET_ID) ||
			source.path !== (source.parentId === "root" ? SOURCE_PATH : TARGET_PATH + SOURCE_PATH)
		) throw new Error("MOVE_PAGE_PROOF_SETUP_NATIVE_FIXTURE");
		const query = () => ctx.db.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) => q
				.eq("organizationId", ORGANIZATION_ID).eq("workspaceId", WORKSPACE_ID)
				.eq("moveCohortId", undefined).eq("parentId", SOURCE_ID));
		const first = await query().paginate({ cursor: null, numItems: 32, maximumBytesRead: 128 * 1024 });
		if (first.page.length === 0 || first.isDone)
			throw new Error("MOVE_PAGE_PROOF_SETUP_NATIVE_FIRST_PAGE");
		await query().paginate({ cursor: first.continueCursor, numItems: 32, maximumBytesRead: 128 * 1024 });
		throw new Error("MOVE_PAGE_PROOF_SETUP_NATIVE_SECOND_PAGE_SUCCEEDED");
	},
});
