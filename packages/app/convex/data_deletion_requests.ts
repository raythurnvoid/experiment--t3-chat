// Lean helper to enqueue a deletion request doc.
//
// Lives outside `data_deletion.ts` because that module instantiates the R2 client and several
// Workpools at module scope and imports `files_nodes.ts`/`public_api.ts`. Importing it just to
// enqueue a request used to pull that whole graph into `organizations.ts` (and everything that
// imports `organizations.ts`), which made every cold Convex call pay the full module evaluation.

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Creates a deletion request, or updates the existing request for the same target.
 *
 * The same user, organization, or workspace should only have one queued request.
 * If the request already exists, keep the earlier processing time.
 */
export async function data_deletion_db_request(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId?: Id<"organizations">;
		workspaceId?: Id<"organizations_workspaces">;
		scope: Doc<"data_deletion_requests">["scope"];
		eligibleAt?: number;
	},
) {
	// Without an explicit time, wait for the normal retention period.
	// Admin and cleanup paths can pass `eligibleAt` when work should run sooner.
	const eligibleAt = args.eligibleAt ?? Date.now() + RETENTION_MS;

	// User deletion has one queue doc per user.
	if (args.scope === "user") {
		const existing = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_user_scope", (q) => q.eq("userId", args.userId).eq("scope", "user"))
			.first();

		if (existing) {
			// Do not move an existing user deletion later.
			// Keep whichever request becomes eligible first.
			await ctx.db.patch("data_deletion_requests", existing._id, {
				eligibleAt: Math.min(existing.eligibleAt, eligibleAt),
			});
			return existing._id;
		}

		return await ctx.db.insert("data_deletion_requests", {
			userId: args.userId,
			scope: "user",
			eligibleAt,
		});
	}

	// Organization and workspace deletion requests must name the organization they belong to.
	if (!args.organizationId) {
		throw new Error("Organization id is required for organization/workspace deletion requests");
	}

	// Workspace deletion has one queue doc per organization/workspace pair.
	if (args.scope === "workspace") {
		if (!args.workspaceId) {
			throw new Error("Workspace id is required for workspace deletion requests");
		}

		const existingWorkspaceRequests = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_organization_workspace_scope", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("scope", "workspace"),
			)
			.first();

		if (existingWorkspaceRequests) {
			// Do not move an existing workspace deletion later.
			// Keep whichever request becomes eligible first.
			await ctx.db.patch("data_deletion_requests", existingWorkspaceRequests._id, {
				eligibleAt: Math.min(existingWorkspaceRequests.eligibleAt, eligibleAt),
			});
			return existingWorkspaceRequests._id;
		}

		return await ctx.db.insert("data_deletion_requests", {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			scope: "workspace",
			eligibleAt,
		});
	}

	// Organization deletion has one queue doc per organization. It is separate from
	// workspace requests in the same organization.
	const existingOrganizationRequest = await ctx.db
		.query("data_deletion_requests")
		.withIndex("by_organization_scope", (q) => q.eq("organizationId", args.organizationId).eq("scope", "organization"))
		.first();

	if (existingOrganizationRequest) {
		// Do not move an existing organization deletion later.
		// Keep whichever request becomes eligible first.
		await ctx.db.patch("data_deletion_requests", existingOrganizationRequest._id, {
			eligibleAt: Math.min(existingOrganizationRequest.eligibleAt, eligibleAt),
		});
		return existingOrganizationRequest._id;
	}

	return await ctx.db.insert("data_deletion_requests", {
		userId: args.userId,
		scope: "organization",
		organizationId: args.organizationId,
		eligibleAt,
	});
}
