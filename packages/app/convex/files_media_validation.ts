import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import {
	organizations_is_global_organization_id,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";

// Writers advance this in the same transaction as the file or access change.
export async function files_media_validation_db_advance_version(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"] | null;
	},
) {
	const { organizationId, workspaceId } = args;
	if (organizations_is_global_organization_id(organizationId) || organizations_is_reserved_workspace_id(workspaceId))
		return;
	const version = await ctx.db
		.query("files_media_validation_versions")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId),
		)
		.first();
	if (version) {
		await ctx.db.patch("files_media_validation_versions", version._id, { revision: version.revision + 1 });
	} else {
		await ctx.db.insert("files_media_validation_versions", { organizationId, workspaceId, revision: 1 });
	}
}

export async function files_media_validation_db_capture_versions(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		scopes: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> }[];
	},
) {
	const versions: { id: Id<"files_media_validation_versions">; revision: number }[] = [];
	const pendingVersions: { id: Id<"files_pending_review_versions">; revision: number }[] = [];
	const organizations = new Set<Id<"organizations">>();
	const workspaces = new Set<Id<"organizations_workspaces">>();
	for (const scope of args.scopes) {
		if (workspaces.has(scope.workspaceId)) continue;
		workspaces.add(scope.workspaceId);
		const workspaceIds = organizations.has(scope.organizationId) ? [scope.workspaceId] : [null, scope.workspaceId];
		organizations.add(scope.organizationId);
		for (const workspaceId of workspaceIds) {
			const version = await ctx.db
				.query("files_media_validation_versions")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", workspaceId),
				)
				.first();
			versions.push({
				id:
					version?._id ??
					(await ctx.db.insert("files_media_validation_versions", {
						organizationId: scope.organizationId,
						workspaceId,
						revision: 0,
					})),
				revision: version?.revision ?? 0,
			});
		}
		const pendingVersion = await ctx.db
			.query("files_pending_review_versions")
			.withIndex("by_organization_workspace_user", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("userId", args.userId),
			)
			.first();
		pendingVersions.push({
			id:
				pendingVersion?._id ??
				(await ctx.db.insert("files_pending_review_versions", {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					userId: args.userId,
					revision: 0,
				})),
			revision: pendingVersion?.revision ?? 0,
		});
	}
	return { versions, pendingVersions };
}

export async function files_media_validation_db_versions_match(
	ctx: QueryCtx | MutationCtx,
	pins: Awaited<ReturnType<typeof files_media_validation_db_capture_versions>>,
) {
	// Pin row identity too: deleting and recreating a clock cannot revive an old proof.
	for (const pin of pins.versions) {
		const version = await ctx.db.get("files_media_validation_versions", pin.id);
		if (!version || version.revision !== pin.revision) return false;
	}
	for (const pin of pins.pendingVersions) {
		const version = await ctx.db.get("files_pending_review_versions", pin.id);
		if (!version || version.revision !== pin.revision) return false;
	}
	return true;
}
