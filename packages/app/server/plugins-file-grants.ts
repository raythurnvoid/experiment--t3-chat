import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { internal } from "../convex/_generated/api.js";
import { should_never_happen } from "../shared/shared-utils.ts";

type WriteContext = Pick<MutationCtx, "db" | "scheduler">;
type Scope = { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> | null };

const JOB_WATCHDOG_MS = 60_000;

export async function plugins_file_grants_db_get_pair(
	ctx: Pick<QueryCtx, "db">,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		userId: Id<"users">;
		membershipLifetime: number;
	},
) {
	return await ctx.db
		.query("plugins_file_pairs")
		.withIndex("by_installation_user_lifetime", (q) =>
			q
				.eq("installationId", args.installationId)
				.eq("userId", args.userId)
				.eq("membershipLifetime", args.membershipLifetime),
		)
		.first();
}

// The caller first authorizes the member and ensures their membership lifetime.
export async function plugins_file_grants_db_ensure_pair(
	ctx: Pick<MutationCtx, "db">,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		membership: Doc<"organizations_workspaces_users">;
		membershipLifetime: number;
	},
) {
	const { installation, membership, membershipLifetime } = args;
	const existing = await plugins_file_grants_db_get_pair(ctx, {
		installationId: installation._id,
		userId: membership.userId,
		membershipLifetime,
	});
	if (existing) {
		if (existing.membershipId !== membership._id)
			throw should_never_happen("Plugin file pair has a different membership", { pairId: existing._id });
		return existing;
	}
	const id = await ctx.db.insert("plugins_file_pairs", {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		installationId: installation._id,
		userId: membership.userId,
		membershipId: membership._id,
		membershipLifetime,
		createdAt: Date.now(),
	});
	return (await ctx.db.get("plugins_file_pairs", id))!;
}

export async function plugins_file_grants_db_validate_pair(
	ctx: Pick<QueryCtx, "db">,
	args: {
		pairId: Id<"plugins_file_pairs">;
		installationId?: Id<"plugins_workspace_installations">;
		userId?: Id<"users">;
	},
) {
	const pair = await ctx.db.get("plugins_file_pairs", args.pairId);
	if (
		!pair ||
		(args.installationId !== undefined && pair.installationId !== args.installationId) ||
		(args.userId !== undefined && pair.userId !== args.userId)
	)
		return null;
	const [installation, organization, workspace, membership, lifetime, user] = await Promise.all([
		ctx.db.get("plugins_workspace_installations", pair.installationId),
		ctx.db.get("organizations", pair.organizationId),
		ctx.db.get("organizations_workspaces", pair.workspaceId),
		ctx.db.get("organizations_workspaces_users", pair.membershipId),
		ctx.db
			.query("organizations_membership_lifetimes")
			.withIndex("by_workspace_user", (q) => q.eq("workspaceId", pair.workspaceId).eq("userId", pair.userId))
			.first(),
		ctx.db.get("users", pair.userId),
	]);
	if (
		!installation ||
		installation.organizationId !== pair.organizationId ||
		installation.workspaceId !== pair.workspaceId ||
		!organization?.defaultWorkspaceId ||
		!workspace ||
		workspace.organizationId !== pair.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		!user ||
		user.deletedAt !== undefined ||
		!membership?.active ||
		membership.pendingOrganizationRemoval ||
		membership.userId !== pair.userId ||
		membership.organizationId !== pair.organizationId ||
		membership.workspaceId !== pair.workspaceId ||
		!lifetime?.active ||
		lifetime.organizationId !== pair.organizationId ||
		lifetime.membershipId !== pair.membershipId ||
		lifetime.lifetime !== pair.membershipLifetime
	)
		return null;
	const owner = await ctx.db.get("users", organization.ownerUserId);
	if (!owner || owner.deletedAt !== undefined) return null;
	// Credential resolvers own enabled status, capabilities, version and trusted account binding.
	return pair;
}

export async function plugins_file_grants_db_get_authority_pins(
	db: QueryCtx["db"],
	scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	const read = (workspaceId: Scope["workspaceId"]) =>
		db
			.query("plugins_file_authority_versions")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", workspaceId),
			)
			.first();
	const [organization, workspace] = await Promise.all([read(null), read(scope.workspaceId)]);
	return {
		organizationAuthorityPin: organization ? { id: organization._id, revision: organization.revision } : null,
		workspaceAuthorityPin: workspace ? { id: workspace._id, revision: workspace.revision } : null,
	};
}

// Every schedule, including recovery, gets a new step. Old callbacks cannot take it over.
export async function plugins_file_grants_db_schedule(
	ctx: WriteContext,
	job: Pick<Doc<"plugins_file_grant_jobs">, "_id" | "step" | "phase">,
) {
	const step = job.step + 1;
	const scheduledId = await ctx.scheduler.runAfter(0, internal.plugins_file_grants.advance, {
		jobId: job._id,
		step,
		phase: job.phase,
	});
	await ctx.db.patch("plugins_file_grant_jobs", job._id, {
		step,
		scheduledId,
		dueAt: Date.now() + JOB_WATCHDOG_MS,
	});
}

export async function plugins_file_grants_db_advance_authority(ctx: WriteContext, scope: Scope) {
	const organization = await ctx.db.get("organizations", scope.organizationId);
	if (!organization) return;
	if (scope.workspaceId) {
		const workspace = await ctx.db.get("organizations_workspaces", scope.workspaceId);
		if (
			!workspace ||
			workspace.organizationId !== scope.organizationId ||
			workspace.pluginDataPurgeStartedAt !== undefined
		)
			return;
	}
	const clock = await ctx.db
		.query("plugins_file_authority_versions")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
		)
		.first();
	const revision = (clock?.revision ?? 0) + 1;
	if (clock) await ctx.db.patch("plugins_file_authority_versions", clock._id, { revision });
	else
		await ctx.db.insert("plugins_file_authority_versions", {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			revision,
		});
	const existing = await ctx.db
		.query("plugins_file_grant_jobs")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
		)
		.first();
	if (existing) {
		await ctx.db.patch("plugins_file_grant_jobs", existing._id, { requestedRevision: revision });
		return;
	}
	const jobId = await ctx.db.insert("plugins_file_grant_jobs", {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		requestedRevision: revision,
		passRevision: revision,
		phase: "next",
		cursor: null,
		passDone: false,
		consentId: null,
		consentRevision: null,
		readAllowed: null,
		writeAllowed: null,
		organizationAuthorityPin: null,
		workspaceAuthorityPin: null,
		step: 0,
		dueAt: Date.now() + JOB_WATCHDOG_MS,
		scheduledId: null,
	});
	await plugins_file_grants_db_schedule(ctx, { _id: jobId, step: 0, phase: "next" });
}
