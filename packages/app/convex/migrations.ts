import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Doc, Id } from "./_generated/dataModel.js";
import { internalMutation } from "./_generated/server.js";
import type { access_control_Permission, access_control_Role } from "../shared/access-control.ts";
import { quotas } from "../shared/quotas.ts";
import {
	access_control_db_ensure_role_assignment,
	access_control_db_ensure_role_permission_grant,
} from "./access_control.ts";

const app_migrations = new Migrations<DataModel>(components.migrations, {
	internalMutation,
});

type LegacyBillingUsageSnapshot = Omit<Doc<"billing_usage_snapshots">, "_id" | "_creationTime"> & {
	_id: Id<"billing_usage_snapshots">;
	_creationTime: number;
	lastGrantedPeriodStart?: string;
	lastRefreshReason?: string;
	optimisticCreditAppliedKey?: string;
};

type NotificationWithCreatedAt = Doc<"notifications"> & {
	createdAt?: number;
};

type LegacyFilesR2Asset = Omit<Doc<"files_r2_assets">, "_id" | "_creationTime"> & {
	_id: Id<"files_r2_assets">;
	_creationTime: number;
	conversionStatus?: "uploaded" | "converting" | "converted" | "failed";
	shadowNodeId?: Id<"files_nodes">;
};

type LegacyFilesNode = Omit<Doc<"files_nodes">, "_id" | "_creationTime" | "shadowFileNodeIds"> & {
	_id: Id<"files_nodes">;
	_creationTime: number;
	// Remove the intermediate shadow field names used before the schema settled on explicit file-node terminology.
	shadowSourceNodeId?: Id<"files_nodes">;
	shadowNodeIds?: Array<Id<"files_nodes">>;
	shadowFileNodeIds?: Array<Id<"files_nodes">>;
};

type LegacyWorkspaceWithOwner = Omit<Doc<"workspaces">, "_id" | "_creationTime" | "ownerUserId"> & {
	_id: Id<"workspaces">;
	_creationTime: number;
	owner?: Id<"users">;
	ownerUserId?: Id<"users">;
};

const access_control_workspace_role_permission_grants = [
	{ role: "admin", permission: "workspace.update" },
	{ role: "admin", permission: "workspace.members.manage" },
	{ role: "admin", permission: "project.create" },
	{ role: "admin", permission: "project.update" },
	{ role: "admin", permission: "project.delete" },
	{ role: "admin", permission: "project.members.manage" },
	{ role: "admin", permission: "asset.read" },
	{ role: "admin", permission: "asset.write" },
	{ role: "admin", permission: "workspace.roles.manage" },
	{ role: "admin", permission: "asset.permissions.manage" },
	{ role: "member", permission: "workspace.update" },
	{ role: "member", permission: "project.create" },
	{ role: "member", permission: "project.update" },
	{ role: "member", permission: "project.delete" },
	{ role: "member", permission: "asset.read" },
	{ role: "member", permission: "asset.write" },
] as const satisfies Array<{ role: access_control_Role; permission: access_control_Permission }>;

const access_control_project_role_permission_grants = [
	{ role: "admin", permission: "project.update" },
	{ role: "admin", permission: "project.delete" },
	{ role: "admin", permission: "project.members.manage" },
	{ role: "admin", permission: "asset.read" },
	{ role: "admin", permission: "asset.write" },
	{ role: "admin", permission: "asset.permissions.manage" },
	{ role: "member", permission: "project.update" },
	{ role: "member", permission: "project.delete" },
	{ role: "member", permission: "asset.read" },
	{ role: "member", permission: "asset.write" },
] as const satisfies Array<{ role: access_control_Role; permission: access_control_Permission }>;

export const remove_billing_usage_snapshots_last_granted_period_start = app_migrations.define({
	table: "billing_usage_snapshots",
	migrateOne: async (ctx, snapshot) => {
		const legacySnapshot = snapshot as LegacyBillingUsageSnapshot;
		if (legacySnapshot.lastGrantedPeriodStart === undefined) {
			return;
		}

		const { _id, _creationTime, lastGrantedPeriodStart: _lastGrantedPeriodStart, ...next } = legacySnapshot;
		await ctx.db.replace("billing_usage_snapshots", _id, next);
	},
});

export const remove_billing_usage_snapshots_optimistic_credit_applied_key = app_migrations.define({
	table: "billing_usage_snapshots",
	migrateOne: async (ctx, snapshot) => {
		const legacySnapshot = snapshot as LegacyBillingUsageSnapshot;
		if (legacySnapshot.optimisticCreditAppliedKey === undefined) {
			return;
		}

		const { _id, _creationTime, optimisticCreditAppliedKey: _optimisticCreditAppliedKey, ...next } = legacySnapshot;
		await ctx.db.replace("billing_usage_snapshots", _id, next);
	},
});

export const remove_billing_usage_snapshots_last_refresh_reason = app_migrations.define({
	table: "billing_usage_snapshots",
	migrateOne: async (ctx, snapshot) => {
		const legacySnapshot = snapshot as LegacyBillingUsageSnapshot;
		if (legacySnapshot.lastRefreshReason === undefined) {
			return;
		}

		const { _id, _creationTime, lastRefreshReason: _lastRefreshReason, ...next } = legacySnapshot;
		await ctx.db.replace("billing_usage_snapshots", _id, next);
	},
});

export const backfill_workspaces_owner_user_id_from_owner = app_migrations.define({
	table: "workspaces",
	migrateOne: async (ctx, workspace) => {
		const legacyWorkspace = workspace as LegacyWorkspaceWithOwner;
		if (legacyWorkspace.owner === undefined && legacyWorkspace.ownerUserId !== undefined) {
			return;
		}

		const { _id, _creationTime, owner, ownerUserId, ...next } = legacyWorkspace;
		const nextOwnerUserId = ownerUserId ?? owner;
		if (!nextOwnerUserId) {
			return;
		}

		// Recover deployments that were temporarily migrated to `owner` before the schema settled on `ownerUserId`.
		await ctx.db.replace("workspaces", _id, {
			...next,
			ownerUserId: nextOwnerUserId,
		});
	},
});

export const backfill_workspace_home_memberships = app_migrations.define({
	table: "workspaces_projects_users",
	migrateOne: async (ctx, membership) => {
		if (membership.active === false) {
			return;
		}

		const workspace = await ctx.db.get("workspaces", membership.workspaceId);
		if (!workspace?.defaultProjectId || membership.projectId === workspace.defaultProjectId) {
			return;
		}
		const defaultProjectId = workspace.defaultProjectId;

		const existingHomeMemberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_user_workspace_project_active", (q) =>
				q.eq("userId", membership.userId).eq("workspaceId", membership.workspaceId).eq("projectId", defaultProjectId),
			)
			.collect();
		if (existingHomeMemberships.some((homeMembership) => homeMembership.active !== false)) {
			return;
		}

		await ctx.db.insert("workspaces_projects_users", {
			workspaceId: membership.workspaceId,
			projectId: defaultProjectId,
			userId: membership.userId,
			active: true,
			updatedAt: Date.now(),
		});
	},
});

export const backfill_access_control_member_assignments = app_migrations.define({
	table: "workspaces_projects_users",
	migrateOne: async (ctx, membership) => {
		if (membership.active === false) {
			return;
		}

		const existingAssignments = await ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_workspace_project_user_role", (q) =>
				q
					.eq("workspaceId", membership.workspaceId)
					.eq("projectId", membership.projectId)
					.eq("userId", membership.userId),
			)
			.collect();
		if (existingAssignments.length > 0) {
			return;
		}

		await access_control_db_ensure_role_assignment(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			userId: membership.userId,
			role: "member",
			now: Date.now(),
		});
	},
});

export const seed_access_control_workspace_permission_grants = app_migrations.define({
	table: "workspaces",
	migrateOne: async (ctx, workspace) => {
		if (!workspace.defaultProjectId) {
			return;
		}

		const now = Date.now();
		for (const grant of access_control_workspace_role_permission_grants) {
			await access_control_db_ensure_role_permission_grant(ctx, {
				workspaceId: workspace._id,
				projectId: workspace.defaultProjectId,
				resourceKind: "workspace",
				resourceId: String(workspace._id),
				role: grant.role,
				permission: grant.permission,
				now,
			});
		}
	},
});

export const seed_access_control_project_permission_grants = app_migrations.define({
	table: "workspaces_projects",
	migrateOne: async (ctx, project) => {
		const now = Date.now();
		for (const grant of access_control_project_role_permission_grants) {
			await access_control_db_ensure_role_permission_grant(ctx, {
				workspaceId: project.workspaceId,
				projectId: project._id,
				resourceKind: "project",
				resourceId: String(project._id),
				role: grant.role,
				permission: grant.permission,
				now,
			});
		}
	},
});

export const remove_access_control_member_management_grants = app_migrations.define({
	table: "access_control_permission_grants",
	migrateOne: async (ctx, grant) => {
		if (
			grant.principalKind !== "role" ||
			grant.role !== "member" ||
			(grant.permission !== "workspace.members.manage" && grant.permission !== "project.members.manage")
		) {
			return;
		}

		await ctx.db.delete("access_control_permission_grants", grant._id);
	},
});

export const cleanup_duplicate_access_control_owner_assignments = app_migrations.define({
	table: "workspaces",
	migrateOne: async (ctx, workspace) => {
		if (!workspace.defaultProjectId) {
			return;
		}
		const defaultProjectId = workspace.defaultProjectId;

		const ownerAssignments = await ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_workspace_project_role_user", (q) =>
				q.eq("workspaceId", workspace._id).eq("projectId", defaultProjectId).eq("role", "owner"),
			)
			.collect();

		const sortedOwnerAssignments = ownerAssignments.sort((a, b) => a._creationTime - b._creationTime);
		const workspaceOwnerUserId = workspace.ownerUserId;
		const keptAssignment = workspaceOwnerUserId
			? (sortedOwnerAssignments.find((assignment) => assignment.userId === workspaceOwnerUserId) ??
				sortedOwnerAssignments[0])
			: sortedOwnerAssignments[0];
		if (!keptAssignment) {
			return;
		}

		const duplicateAssignments = sortedOwnerAssignments.filter((assignment) => assignment._id !== keptAssignment._id);
		await Promise.all(
			duplicateAssignments.map((assignment) => ctx.db.delete("access_control_role_assignments", assignment._id)),
		);
	},
});

export const update_extra_workspaces_quota_max_count_to_2 = app_migrations.define({
	table: "quotas",
	migrateOne: async (ctx, quota) => {
		if (quota.quotaName !== "extra_workspaces" || quota.maxCount === quotas.extra_workspaces.maxCount) {
			return;
		}

		await ctx.db.patch("quotas", quota._id, {
			maxCount: quotas.extra_workspaces.maxCount,
			updatedAt: Date.now(),
		});
	},
});

export const remove_notifications_created_at = app_migrations.define({
	table: "notifications",
	migrateOne: async (ctx, notification) => {
		const legacyNotification = notification as NotificationWithCreatedAt;
		if (legacyNotification.createdAt === undefined) {
			return;
		}

		const { _id, _creationTime, createdAt: _createdAt, ...next } = legacyNotification;
		await ctx.db.replace("notifications", _id, next);
	},
});

export const remove_files_r2_assets_conversion_status = app_migrations.define({
	table: "files_r2_assets",
	migrateOne: async (ctx, asset) => {
		const legacyAsset = asset as LegacyFilesR2Asset;
		if (legacyAsset.conversionStatus === undefined) {
			return;
		}

		const { _id, _creationTime, conversionStatus: _conversionStatus, ...next } = legacyAsset;
		await ctx.db.replace("files_r2_assets", _id, next);
	},
});

export const backfill_files_nodes_shadow_file_node_ids = app_migrations.define({
	table: "files_nodes",
	migrateOne: async (ctx, node) => {
		const legacyNode = node as LegacyFilesNode;
		if (
			legacyNode.shadowFileNodeIds !== undefined &&
			legacyNode.shadowNodeIds === undefined &&
			legacyNode.shadowSourceNodeId === undefined
		) {
			return;
		}

		const {
			_id,
			_creationTime,
			shadowSourceNodeId,
			shadowNodeIds,
			shadowSourceFileNodeId,
			shadowFileNodeIds,
			...next
		} = legacyNode;
		const nextShadowSourceFileNodeId = shadowSourceFileNodeId ?? shadowSourceNodeId;
		await ctx.db.replace("files_nodes", _id, {
			...next,
			...(nextShadowSourceFileNodeId ? { shadowSourceFileNodeId: nextShadowSourceFileNodeId } : {}),
			shadowFileNodeIds: shadowFileNodeIds ?? shadowNodeIds ?? [],
		});
	},
});

export const backfill_files_node_shadow_links_from_assets = app_migrations.define({
	table: "files_r2_assets",
	migrateOne: async (ctx, asset) => {
		const legacyAsset = asset as LegacyFilesR2Asset;
		if (legacyAsset.shadowNodeId === undefined) {
			return;
		}

		const [sourceFile, shadowFile] = await Promise.all([
			ctx.db.get("files_nodes", legacyAsset.sourceNodeId),
			ctx.db.get("files_nodes", legacyAsset.shadowNodeId),
		]);
		if (!sourceFile || !shadowFile) {
			return;
		}

		const legacySourceFile = sourceFile as LegacyFilesNode;
		const nextShadowFileNodeIds = legacySourceFile.shadowFileNodeIds ?? legacySourceFile.shadowNodeIds ?? [];
		await Promise.all([
			nextShadowFileNodeIds.includes(legacyAsset.shadowNodeId)
				? null
					: ctx.db.patch("files_nodes", sourceFile._id, {
						shadowFileNodeIds: [...nextShadowFileNodeIds, legacyAsset.shadowNodeId],
					}),
			ctx.db.patch("files_nodes", shadowFile._id, {
				shadowSourceFileNodeId: sourceFile._id,
				shadowFileNodeIds:
					(shadowFile as LegacyFilesNode).shadowFileNodeIds ?? (shadowFile as LegacyFilesNode).shadowNodeIds ?? [],
			}),
		]);
	},
});

export const remove_files_r2_assets_shadow_node_id = app_migrations.define({
	table: "files_r2_assets",
	migrateOne: async (ctx, asset) => {
		const legacyAsset = asset as LegacyFilesR2Asset;
		if (legacyAsset.shadowNodeId === undefined) {
			return;
		}

		const { _id, _creationTime, shadowNodeId: _shadowNodeId, ...next } = legacyAsset;
		await ctx.db.replace("files_r2_assets", _id, next);
	},
});

/** Run migrations from the CLI: `pnpm exec convex run migrations:run -- ...` (cwd: packages/app). */
export const run = app_migrations.runner();
export const run_remove_billing_usage_snapshots_last_granted_period_start = app_migrations.runner(
	internal.migrations.remove_billing_usage_snapshots_last_granted_period_start,
);
export const run_remove_billing_usage_snapshots_optimistic_credit_applied_key = app_migrations.runner(
	internal.migrations.remove_billing_usage_snapshots_optimistic_credit_applied_key,
);
export const run_remove_billing_usage_snapshots_last_refresh_reason = app_migrations.runner(
	internal.migrations.remove_billing_usage_snapshots_last_refresh_reason,
);
export const run_remove_notifications_created_at = app_migrations.runner(
	internal.migrations.remove_notifications_created_at,
);
export const run_remove_files_r2_assets_conversion_status = app_migrations.runner(
	internal.migrations.remove_files_r2_assets_conversion_status,
);
export const run_backfill_files_nodes_shadow_file_node_ids = app_migrations.runner(
	internal.migrations.backfill_files_nodes_shadow_file_node_ids,
);
export const run_backfill_files_node_shadow_links_from_assets = app_migrations.runner(
	internal.migrations.backfill_files_node_shadow_links_from_assets,
);
export const run_remove_files_r2_assets_shadow_node_id = app_migrations.runner(
	internal.migrations.remove_files_r2_assets_shadow_node_id,
);
export const run_backfill_workspaces_owner_user_id_from_owner = app_migrations.runner(
	internal.migrations.backfill_workspaces_owner_user_id_from_owner,
);
export const run_backfill_workspace_home_memberships = app_migrations.runner(
	internal.migrations.backfill_workspace_home_memberships,
);
export const run_backfill_access_control_member_assignments = app_migrations.runner(
	internal.migrations.backfill_access_control_member_assignments,
);
export const run_seed_access_control_workspace_permission_grants = app_migrations.runner(
	internal.migrations.seed_access_control_workspace_permission_grants,
);
export const run_seed_access_control_project_permission_grants = app_migrations.runner(
	internal.migrations.seed_access_control_project_permission_grants,
);
export const run_remove_access_control_member_management_grants = app_migrations.runner(
	internal.migrations.remove_access_control_member_management_grants,
);
export const run_cleanup_duplicate_access_control_owner_assignments = app_migrations.runner(
	internal.migrations.cleanup_duplicate_access_control_owner_assignments,
);
export const run_update_extra_workspaces_quota_max_count_to_2 = app_migrations.runner(
	internal.migrations.update_extra_workspaces_quota_max_count_to_2,
);
