import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { organizations_is_global_organization_id } from "../shared/organizations.ts";
import { files_db_resolve_scope } from "./files_scopes.ts";

// Writers advance this in the same transaction as the access or structure change.
export async function files_media_validation_db_advance_version(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"] | null;
	},
) {
	const { organizationId } = args;
	if (organizations_is_global_organization_id(organizationId)) return;
	// Null tracks organization-wide access changes. Mount storage has no tenant media clock.
	let workspaceId: Id<"organizations_workspaces"> | null = null;
	if (args.workspaceId !== null) {
		const scope = files_db_resolve_scope(ctx, args.workspaceId);
		if (scope.kind !== "workspace") return;
		workspaceId = scope.workspaceId;
	}
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

/**
 * A new file or replaced content changes only what media proofs see. Access and structure changes use
 * `files_media_validation_db_advance_version`, which a Move also pins.
 */
export async function files_media_validation_db_advance_content_version(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
	},
) {
	const { organizationId } = args;
	if (organizations_is_global_organization_id(organizationId)) return;
	const scope = files_db_resolve_scope(ctx, args.workspaceId);
	if (scope.kind !== "workspace") return;
	const version = await ctx.db
		.query("files_content_versions")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", scope.workspaceId),
		)
		.first();
	if (version) {
		await ctx.db.patch("files_content_versions", version._id, { revision: version.revision + 1 });
	} else {
		await ctx.db.insert("files_content_versions", { organizationId, workspaceId: scope.workspaceId, revision: 1 });
	}
}

/**
 * `versions` starts with the access clocks: the organization, then each workspace. The content clocks
 * come after them.
 */
export async function files_media_validation_db_capture_versions(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		scopes: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> }[];
	},
) {
	const versions: { id: Id<"files_media_validation_versions">; revision: number }[] = [];
	const contentVersions: { id: Id<"files_content_versions">; revision: number }[] = [];
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
		const contentVersion = await ctx.db
			.query("files_content_versions")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
			)
			.first();
		contentVersions.push({
			id:
				contentVersion?._id ??
				(await ctx.db.insert("files_content_versions", {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					revision: 0,
				})),
			revision: contentVersion?.revision ?? 0,
		});
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
	const allVersions: { id: Id<"files_media_validation_versions"> | Id<"files_content_versions">; revision: number }[] =
		[...versions, ...contentVersions];
	return { versions: allVersions, pendingVersions };
}

export async function files_media_validation_db_versions_match(
	ctx: QueryCtx | MutationCtx,
	pins: Awaited<ReturnType<typeof files_media_validation_db_capture_versions>>,
) {
	// Pin row identity too: deleting and recreating a clock cannot revive an old proof.
	for (const pin of pins.versions) {
		const contentId = ctx.db.normalizeId("files_content_versions", pin.id);
		const version = contentId
			? await ctx.db.get("files_content_versions", contentId)
			: await ctx.db.get("files_media_validation_versions", pin.id as Id<"files_media_validation_versions">);
		if (!version || version.revision !== pin.revision) return false;
	}
	for (const pin of pins.pendingVersions) {
		const version = await ctx.db.get("files_pending_review_versions", pin.id);
		if (!version || version.revision !== pin.revision) return false;
	}
	return true;
}
