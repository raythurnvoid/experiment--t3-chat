import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Doc, Id, TableNames } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import type { access_control_Permission, access_control_Role } from "../shared/access-control.ts";
import { quotas } from "../shared/quotas.ts";
import {
	access_control_db_ensure_role_assignment,
	access_control_db_ensure_role_permission_grant,
} from "./access_control.ts";
import { path_extract_segments_from } from "../shared/shared-utils.ts";

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

type SecretWithKeyVersion = Doc<"plugins_workspace_installation_secrets"> & {
	keyVersion?: number;
};

/** Tables that stamped their own createdAt before `_creationTime` took over. */
type PluginsLegacyCreatedAtTable =
	| "plugins_publisher_repositories"
	| "plugins_publisher_repository_secrets"
	| "plugins_versions"
	| "plugins_workspace_installations"
	| "plugins_workspace_event_handlers"
	| "plugins_event_runs"
	| "plugins_event_run_calls";

type PluginsDocWithLegacyCreatedAt<TableName extends PluginsLegacyCreatedAtTable> = Doc<TableName> & {
	createdAt?: number;
};

type LegacyVersionReview = Omit<Doc<"plugins_version_reviews">, "updatedAt"> & {
	createdAt?: number;
	updatedAt?: number;
};

type LegacyOrganizationWithOwner = Omit<Doc<"organizations">, "_id" | "_creationTime" | "ownerUserId"> & {
	_id: Id<"organizations">;
	_creationTime: number;
	owner?: Id<"users">;
	ownerUserId?: Id<"users">;
};

type FileNodeReferenceTable =
	| "files_pending_updates"
	| "files_pending_updates_last_sequence_saved"
	| "file_stats"
	| "files_markdown_chunks"
	| "files_plain_text_chunks"
	| "files_yjs_snapshots"
	| "files_yjs_updates"
	| "files_yjs_docs_last_sequences"
	| "files_content_materialization_jobs"
	| "files_snapshots";

type LegacyFileNodeReferenceDoc<TableName extends FileNodeReferenceTable> = Omit<Doc<TableName>, "fileNodeId"> & {
	fileNodeId?: Id<"files_nodes">;
	nodeId?: Id<"files_nodes">;
};

type RebrandCleanupTableName = Exclude<TableNames, "users" | "users_anagraphics">;

const rebrand_cleanup_tables = [
	"access_control_permission_grants",
	"access_control_role_assignments",
	"ai_chat_files_content",
	"ai_chat_files",
	"ai_chat_threads_messages_aisdk_5",
	"ai_chat_threads_state",
	"ai_chat_threads",
	"api_credentials",
	"billing_cancel_polar_subscription_jobs",
	"billing_usage_snapshots",
	"chat_messages",
	"clerk_webhook_receipts",
	"data_deletion_requests",
	"file_stats",
	"files_content_materialization_jobs",
	"files_markdown_chunks",
	"files_metadata_docs",
	"files_nodes",
	"files_pending_updates_cleanup_tasks",
	"files_pending_updates_last_sequence_saved",
	"files_pending_updates",
	"files_plain_text_chunks",
	"files_r2_assets",
	"files_snapshots",
	"files_yjs_docs_last_sequences",
	"files_yjs_snapshots",
	"files_yjs_updates",
	"github_sources",
	"notifications",
	"public_api_grants",
	"quotas",
	"users_anon_tokens",
	"value_store",
	"organizations_workspaces_users",
	"organizations_workspaces",
	"organizations",
] as const satisfies readonly RebrandCleanupTableName[];

async function delete_rebrand_cleanup_batch<TableName extends RebrandCleanupTableName>(
	ctx: MutationCtx,
	tableName: TableName,
	batchSize: number,
) {
	const docs = await ctx.db.query(tableName).take(batchSize);
	await Promise.all(docs.map((doc) => ctx.db.delete(tableName, doc._id)));
	return docs.length;
}

function rename_legacy_node_id_to_file_node_id<TableName extends FileNodeReferenceTable>(doc: Doc<TableName>) {
	const legacyDoc = doc as LegacyFileNodeReferenceDoc<TableName>;
	if (legacyDoc.nodeId === undefined) {
		return;
	}

	return {
		fileNodeId: legacyDoc.fileNodeId ?? legacyDoc.nodeId,
		nodeId: undefined,
	};
}

function files_migrations_path_depth(path: string) {
	return path === "/" ? 0 : path_extract_segments_from(path).length;
}

function files_migrations_lowercase_extension(path: string, kind: Doc<"files_nodes">["kind"]) {
	if (kind !== "file") {
		return null;
	}
	const name = path_extract_segments_from(path).at(-1) ?? "";
	const dotIndex = name.lastIndexOf(".");
	if (dotIndex <= 0 || dotIndex === name.length - 1) {
		return null;
	}
	return name.slice(dotIndex + 1).toLowerCase();
}

const access_control_organization_role_permission_grants = [
	{ role: "admin", permission: "organization.update" },
	{ role: "admin", permission: "organization.members.manage" },
	{ role: "admin", permission: "workspace.create" },
	{ role: "admin", permission: "workspace.update" },
	{ role: "admin", permission: "workspace.delete" },
	{ role: "admin", permission: "workspace.members.manage" },
	{ role: "admin", permission: "asset.read" },
	{ role: "admin", permission: "asset.write" },
	{ role: "admin", permission: "organization.roles.manage" },
	{ role: "admin", permission: "asset.permissions.manage" },
	{ role: "admin", permission: "api.credentials.manage" },
	{ role: "member", permission: "organization.update" },
	{ role: "member", permission: "workspace.create" },
	{ role: "member", permission: "workspace.update" },
	{ role: "member", permission: "workspace.delete" },
	{ role: "member", permission: "asset.read" },
	{ role: "member", permission: "asset.write" },
] as const satisfies Array<{ role: access_control_Role; permission: access_control_Permission }>;

const access_control_workspace_role_permission_grants = [
	{ role: "admin", permission: "workspace.update" },
	{ role: "admin", permission: "workspace.delete" },
	{ role: "admin", permission: "workspace.members.manage" },
	{ role: "admin", permission: "asset.read" },
	{ role: "admin", permission: "asset.write" },
	{ role: "admin", permission: "asset.permissions.manage" },
	{ role: "admin", permission: "api.credentials.manage" },
	{ role: "member", permission: "workspace.update" },
	{ role: "member", permission: "workspace.delete" },
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

export const backfill_organizations_owner_user_id_from_owner = app_migrations.define({
	table: "organizations",
	migrateOne: async (ctx, organization) => {
		const legacyOrganization = organization as LegacyOrganizationWithOwner;
		if (legacyOrganization.owner === undefined && legacyOrganization.ownerUserId !== undefined) {
			return;
		}

		const { _id, _creationTime, owner, ownerUserId, ...next } = legacyOrganization;
		const nextOwnerUserId = ownerUserId ?? owner;
		if (!nextOwnerUserId) {
			return;
		}

		// Recover deployments that were temporarily migrated to `owner` before the schema settled on `ownerUserId`.
		await ctx.db.replace("organizations", _id, {
			...next,
			ownerUserId: nextOwnerUserId,
		});
	},
});

export const backfill_organization_home_memberships = app_migrations.define({
	table: "organizations_workspaces_users",
	migrateOne: async (ctx, membership) => {
		if (membership.active === false) {
			return;
		}

		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization?.defaultWorkspaceId || membership.workspaceId === organization.defaultWorkspaceId) {
			return;
		}
		const defaultWorkspaceId = organization.defaultWorkspaceId;

		const existingHomeMemberships = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) =>
				q
					.eq("userId", membership.userId)
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", defaultWorkspaceId),
			)
			.collect();
		if (existingHomeMemberships.some((homeMembership) => homeMembership.active === true)) {
			return;
		}

		await ctx.db.insert("organizations_workspaces_users", {
			organizationId: membership.organizationId,
			workspaceId: defaultWorkspaceId,
			userId: membership.userId,
			active: true,
			updatedAt: Date.now(),
		});
	},
});

export const backfill_access_control_member_assignments = app_migrations.define({
	table: "organizations_workspaces_users",
	migrateOne: async (ctx, membership) => {
		if (membership.active === false) {
			return;
		}

		const existingAssignments = await ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_organization_workspace_user_role", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", membership.userId),
			)
			.collect();
		if (existingAssignments.length > 0) {
			return;
		}

		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			role: "member",
			now: Date.now(),
		});
	},
});

export const seed_access_control_organization_permission_grants = app_migrations.define({
	table: "organizations",
	migrateOne: async (ctx, organization) => {
		if (!organization.defaultWorkspaceId) {
			return;
		}

		const now = Date.now();
		for (const grant of access_control_organization_role_permission_grants) {
			await access_control_db_ensure_role_permission_grant(ctx, {
				organizationId: organization._id,
				workspaceId: organization.defaultWorkspaceId,
				resourceKind: "organization",
				resourceId: String(organization._id),
				role: grant.role,
				permission: grant.permission,
				now,
			});
		}
	},
});

export const seed_access_control_workspace_permission_grants = app_migrations.define({
	table: "organizations_workspaces",
	migrateOne: async (ctx, workspace) => {
		const now = Date.now();
		for (const grant of access_control_workspace_role_permission_grants) {
			await access_control_db_ensure_role_permission_grant(ctx, {
				organizationId: workspace.organizationId,
				workspaceId: workspace._id,
				resourceKind: "workspace",
				resourceId: String(workspace._id),
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
			(grant.permission !== "organization.members.manage" && grant.permission !== "workspace.members.manage")
		) {
			return;
		}

		await ctx.db.delete("access_control_permission_grants", grant._id);
	},
});

export const cleanup_duplicate_access_control_owner_assignments = app_migrations.define({
	table: "organizations",
	migrateOne: async (ctx, organization) => {
		if (!organization.defaultWorkspaceId) {
			return;
		}
		const defaultWorkspaceId = organization.defaultWorkspaceId;

		const ownerAssignments = await ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_organization_workspace_role_user", (q) =>
				q.eq("organizationId", organization._id).eq("workspaceId", defaultWorkspaceId).eq("role", "owner"),
			)
			.collect();

		const sortedOwnerAssignments = ownerAssignments.sort((a, b) => a._creationTime - b._creationTime);
		const organizationOwnerUserId = organization.ownerUserId;
		const keptAssignment = organizationOwnerUserId
			? (sortedOwnerAssignments.find((assignment) => assignment.userId === organizationOwnerUserId) ??
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

export const update_extra_organizations_quota_max_count_to_2 = app_migrations.define({
	table: "quotas",
	migrateOne: async (ctx, quota) => {
		if (quota.quotaName !== "extra_organizations" || quota.maxCount === quotas.extra_organizations.maxCount) {
			return;
		}

		await ctx.db.patch("quotas", quota._id, {
			maxCount: quotas.extra_organizations.maxCount,
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

export const remove_plugins_workspace_installation_secrets_key_version = app_migrations.define({
	table: "plugins_workspace_installation_secrets",
	migrateOne: async (ctx, secret) => {
		const legacySecret = secret as SecretWithKeyVersion;
		if (legacySecret.keyVersion === undefined) {
			return;
		}

		const { _id, _creationTime, keyVersion: _keyVersion, ...next } = legacySecret;
		await ctx.db.replace("plugins_workspace_installation_secrets", _id, next);
	},
});

export const rename_pending_updates_file_node_id = app_migrations.define({
	table: "files_pending_updates",
	migrateOne: (_ctx, pendingUpdate) => rename_legacy_node_id_to_file_node_id(pendingUpdate),
});

export const rename_pending_update_sequences_file_node_id = app_migrations.define({
	table: "files_pending_updates_last_sequence_saved",
	migrateOne: (_ctx, lastSequenceSaved) => rename_legacy_node_id_to_file_node_id(lastSequenceSaved),
});

export const rename_file_stats_file_node_id = app_migrations.define({
	table: "file_stats",
	migrateOne: (_ctx, stats) => rename_legacy_node_id_to_file_node_id(stats),
});

export const rename_markdown_chunks_file_node_id = app_migrations.define({
	table: "files_markdown_chunks",
	migrateOne: (_ctx, chunk) => rename_legacy_node_id_to_file_node_id(chunk),
});

export const rename_plain_text_chunks_file_node_id = app_migrations.define({
	table: "files_plain_text_chunks",
	migrateOne: (_ctx, chunk) => rename_legacy_node_id_to_file_node_id(chunk),
});

export const rename_yjs_snapshots_file_node_id = app_migrations.define({
	table: "files_yjs_snapshots",
	migrateOne: (_ctx, snapshot) => rename_legacy_node_id_to_file_node_id(snapshot),
});

export const rename_yjs_updates_file_node_id = app_migrations.define({
	table: "files_yjs_updates",
	migrateOne: (_ctx, update) => rename_legacy_node_id_to_file_node_id(update),
});

export const rename_yjs_last_sequences_file_node_id = app_migrations.define({
	table: "files_yjs_docs_last_sequences",
	migrateOne: (_ctx, lastSequence) => rename_legacy_node_id_to_file_node_id(lastSequence),
});

export const rename_materialization_jobs_file_node_id = app_migrations.define({
	table: "files_content_materialization_jobs",
	migrateOne: (_ctx, job) => rename_legacy_node_id_to_file_node_id(job),
});

export const rename_file_snapshots_file_node_id = app_migrations.define({
	table: "files_snapshots",
	migrateOne: (_ctx, snapshot) => rename_legacy_node_id_to_file_node_id(snapshot),
});

export const backfill_files_nodes_path_depth = app_migrations.define({
	table: "files_nodes",
	migrateOne: async (ctx, fileNode) => {
		const pathDepth = files_migrations_path_depth(fileNode.path);
		if (fileNode.pathDepth === pathDepth) {
			return;
		}

		await ctx.db.patch("files_nodes", fileNode._id, { pathDepth });
	},
});

export const backfill_files_nodes_lowercase_extension = app_migrations.define({
	table: "files_nodes",
	migrateOne: async (ctx, fileNode) => {
		const lowercaseExtension = files_migrations_lowercase_extension(fileNode.path, fileNode.kind);
		if (fileNode.lowercaseExtension === lowercaseExtension) {
			return;
		}

		await ctx.db.patch("files_nodes", fileNode._id, { lowercaseExtension });
	},
});

export const backfill_files_plain_text_chunk_scope = app_migrations.define({
	table: "files_plain_text_chunks",
	migrateOne: async (ctx, plainTextChunk) => {
		const fileNode = await ctx.db.get("files_nodes", plainTextChunk.fileNodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== plainTextChunk.organizationId ||
			fileNode.workspaceId !== plainTextChunk.workspaceId ||
			fileNode.kind !== "file"
		) {
			return;
		}
		if (plainTextChunk.path === fileNode.path && plainTextChunk.archiveOperationId === fileNode.archiveOperationId) {
			return;
		}

		await ctx.db.patch("files_plain_text_chunks", plainTextChunk._id, {
			path: fileNode.path,
			archiveOperationId: fileNode.archiveOperationId,
		});
	},
});

export const remove_plugins_publisher_repositories_created_at = app_migrations.define({
	table: "plugins_publisher_repositories",
	migrateOne: async (ctx, repository) => {
		const legacyRepository = repository as PluginsDocWithLegacyCreatedAt<"plugins_publisher_repositories">;
		if (legacyRepository.createdAt === undefined) {
			return;
		}

		const { _id, _creationTime, createdAt: _createdAt, ...next } = legacyRepository;
		await ctx.db.replace("plugins_publisher_repositories", _id, next);
	},
});

export const remove_plugins_publisher_repository_secrets_created_at = app_migrations.define({
	table: "plugins_publisher_repository_secrets",
	migrateOne: async (ctx, secret) => {
		const legacySecret = secret as PluginsDocWithLegacyCreatedAt<"plugins_publisher_repository_secrets">;
		if (legacySecret.createdAt === undefined) {
			return;
		}

		const { _id, _creationTime, createdAt: _createdAt, ...next } = legacySecret;
		await ctx.db.replace("plugins_publisher_repository_secrets", _id, next);
	},
});

export const remove_plugins_versions_created_at = app_migrations.define({
	table: "plugins_versions",
	migrateOne: async (ctx, version) => {
		const legacyVersion = version as PluginsDocWithLegacyCreatedAt<"plugins_versions">;
		if (legacyVersion.createdAt === undefined) {
			return;
		}

		const { _id, _creationTime, createdAt: _createdAt, ...next } = legacyVersion;
		await ctx.db.replace("plugins_versions", _id, next);
	},
});

export const remove_plugins_workspace_installations_created_at = app_migrations.define({
	table: "plugins_workspace_installations",
	migrateOne: async (ctx, installation) => {
		const legacyInstallation = installation as PluginsDocWithLegacyCreatedAt<"plugins_workspace_installations">;
		if (legacyInstallation.createdAt === undefined) {
			return;
		}

		const { _id, _creationTime, createdAt: _createdAt, ...next } = legacyInstallation;
		await ctx.db.replace("plugins_workspace_installations", _id, next);
	},
});

export const remove_plugins_workspace_event_handlers_created_at = app_migrations.define({
	table: "plugins_workspace_event_handlers",
	migrateOne: async (ctx, handler) => {
		const legacyHandler = handler as PluginsDocWithLegacyCreatedAt<"plugins_workspace_event_handlers">;
		if (legacyHandler.createdAt === undefined) {
			return;
		}

		const { _id, _creationTime, createdAt: _createdAt, ...next } = legacyHandler;
		await ctx.db.replace("plugins_workspace_event_handlers", _id, next);
	},
});

export const remove_plugins_event_runs_created_at = app_migrations.define({
	table: "plugins_event_runs",
	migrateOne: async (ctx, run) => {
		const legacyRun = run as PluginsDocWithLegacyCreatedAt<"plugins_event_runs">;
		if (legacyRun.createdAt === undefined) {
			return;
		}

		const { _id, _creationTime, createdAt: _createdAt, ...next } = legacyRun;
		await ctx.db.replace("plugins_event_runs", _id, next);
	},
});

export const remove_plugins_event_run_calls_created_at = app_migrations.define({
	table: "plugins_event_run_calls",
	migrateOne: async (ctx, call) => {
		const legacyCall = call as PluginsDocWithLegacyCreatedAt<"plugins_event_run_calls">;
		if (legacyCall.createdAt === undefined) {
			return;
		}

		const { _id, _creationTime, createdAt: _createdAt, ...next } = legacyCall;
		await ctx.db.replace("plugins_event_run_calls", _id, next);
	},
});

export const backfill_plugins_version_reviews_updated_at = app_migrations.define({
	table: "plugins_version_reviews",
	migrateOne: async (ctx, review) => {
		const legacyReview = review as LegacyVersionReview;
		if (legacyReview.createdAt === undefined && legacyReview.updatedAt !== undefined) {
			return;
		}

		// Legacy docs stamped the verdict time as createdAt before the field was renamed updatedAt.
		const { _id, _creationTime, createdAt: _createdAt, ...next } = legacyReview;
		await ctx.db.replace("plugins_version_reviews", _id, {
			...next,
			updatedAt: legacyReview.updatedAt ?? legacyReview.createdAt ?? legacyReview._creationTime,
		});
	},
});

export const backfill_plugins_versions_is_latest = app_migrations.define({
	table: "plugins_versions",
	migrateOne: async (ctx, version) => {
		// Publish order stands in for version order: the newest-created doc per name is the latest.
		const latest = await ctx.db
			.query("plugins_versions")
			.withIndex("by_name", (q) => q.eq("name", version.name))
			.order("desc")
			.first();
		const isLatest = latest?._id === version._id;
		if (version.isLatest === isLatest) {
			return;
		}

		await ctx.db.patch("plugins_versions", version._id, { isLatest });
	},
});

export const dev_cleanup_rebrand_preserve_clerk_accounts = internalMutation({
	args: {
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		done: v.boolean(),
		deletedCount: v.number(),
		patchedUserCount: v.number(),
		preservedUserCount: v.number(),
		preservedAnagraphicCount: v.number(),
	}),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 200;

		for (const tableName of rebrand_cleanup_tables) {
			const deletedCount = await delete_rebrand_cleanup_batch(ctx, tableName, batchSize);
			if (deletedCount > 0) {
				return {
					done: false,
					deletedCount,
					patchedUserCount: 0,
					preservedUserCount: 0,
					preservedAnagraphicCount: 0,
				};
			}
		}

		const users = await ctx.db.query("users").take(batchSize);
		const preservedUserIds = new Set<Id<"users">>();
		let deletedCount = 0;
		let patchedUserCount = 0;

		for (const user of users) {
			if (!user.clerkUserId) {
				if (user.anagraphic) {
					await ctx.db.delete("users_anagraphics", user.anagraphic);
					deletedCount += 1;
				}
				await ctx.db.delete("users", user._id);
				deletedCount += 1;
				continue;
			}

			preservedUserIds.add(user._id);
			if (user.defaultOrganizationId || user.defaultWorkspaceId || user.anonymousAuthToken || user.deletedAt) {
				await ctx.db.patch("users", user._id, {
					defaultOrganizationId: undefined,
					defaultWorkspaceId: undefined,
					anonymousAuthToken: undefined,
					deletedAt: undefined,
				});
				patchedUserCount += 1;
			}
		}

		if (deletedCount > 0 || patchedUserCount > 0) {
			return {
				done: false,
				deletedCount,
				patchedUserCount,
				preservedUserCount: preservedUserIds.size,
				preservedAnagraphicCount: 0,
			};
		}

		const anagraphics = await ctx.db.query("users_anagraphics").take(batchSize);
		let preservedAnagraphicCount = 0;
		for (const anagraphic of anagraphics) {
			if (preservedUserIds.has(anagraphic.userId)) {
				preservedAnagraphicCount += 1;
				continue;
			}

			await ctx.db.delete("users_anagraphics", anagraphic._id);
			deletedCount += 1;
		}

		return {
			done: deletedCount === 0,
			deletedCount,
			patchedUserCount: 0,
			preservedUserCount: preservedUserIds.size,
			preservedAnagraphicCount,
		};
	},
});

/** Run migrations from the CLI: `pnpx convex run migrations:run_<migration_name>` (cwd: packages/app). */
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
export const run_backfill_organizations_owner_user_id_from_owner = app_migrations.runner(
	internal.migrations.backfill_organizations_owner_user_id_from_owner,
);
export const run_backfill_organization_home_memberships = app_migrations.runner(
	internal.migrations.backfill_organization_home_memberships,
);
export const run_backfill_access_control_member_assignments = app_migrations.runner(
	internal.migrations.backfill_access_control_member_assignments,
);
export const run_seed_access_control_organization_permission_grants = app_migrations.runner(
	internal.migrations.seed_access_control_organization_permission_grants,
);
export const run_seed_access_control_workspace_permission_grants = app_migrations.runner(
	internal.migrations.seed_access_control_workspace_permission_grants,
);
export const run_remove_access_control_member_management_grants = app_migrations.runner(
	internal.migrations.remove_access_control_member_management_grants,
);
export const run_cleanup_duplicate_access_control_owner_assignments = app_migrations.runner(
	internal.migrations.cleanup_duplicate_access_control_owner_assignments,
);
export const run_update_extra_organizations_quota_max_count_to_2 = app_migrations.runner(
	internal.migrations.update_extra_organizations_quota_max_count_to_2,
);
export const run_remove_plugins_workspace_installation_secrets_key_version = app_migrations.runner(
	internal.migrations.remove_plugins_workspace_installation_secrets_key_version,
);
export const run_rename_pending_updates_file_node_id = app_migrations.runner(
	internal.migrations.rename_pending_updates_file_node_id,
);
export const run_rename_pending_update_sequences_file_node_id = app_migrations.runner(
	internal.migrations.rename_pending_update_sequences_file_node_id,
);
export const run_rename_file_stats_file_node_id = app_migrations.runner(
	internal.migrations.rename_file_stats_file_node_id,
);
export const run_rename_markdown_chunks_file_node_id = app_migrations.runner(
	internal.migrations.rename_markdown_chunks_file_node_id,
);
export const run_rename_plain_text_chunks_file_node_id = app_migrations.runner(
	internal.migrations.rename_plain_text_chunks_file_node_id,
);
export const run_rename_yjs_snapshots_file_node_id = app_migrations.runner(
	internal.migrations.rename_yjs_snapshots_file_node_id,
);
export const run_rename_yjs_updates_file_node_id = app_migrations.runner(
	internal.migrations.rename_yjs_updates_file_node_id,
);
export const run_rename_yjs_last_sequences_file_node_id = app_migrations.runner(
	internal.migrations.rename_yjs_last_sequences_file_node_id,
);
export const run_rename_materialization_jobs_file_node_id = app_migrations.runner(
	internal.migrations.rename_materialization_jobs_file_node_id,
);
export const run_rename_file_snapshots_file_node_id = app_migrations.runner(
	internal.migrations.rename_file_snapshots_file_node_id,
);
export const run_backfill_files_nodes_path_depth = app_migrations.runner(
	internal.migrations.backfill_files_nodes_path_depth,
);
export const run_backfill_files_nodes_lowercase_extension = app_migrations.runner(
	internal.migrations.backfill_files_nodes_lowercase_extension,
);
export const run_backfill_files_plain_text_chunk_scope = app_migrations.runner(
	internal.migrations.backfill_files_plain_text_chunk_scope,
);
export const run_remove_plugins_publisher_repositories_created_at = app_migrations.runner(
	internal.migrations.remove_plugins_publisher_repositories_created_at,
);
export const run_remove_plugins_publisher_repository_secrets_created_at = app_migrations.runner(
	internal.migrations.remove_plugins_publisher_repository_secrets_created_at,
);
export const run_remove_plugins_versions_created_at = app_migrations.runner(
	internal.migrations.remove_plugins_versions_created_at,
);
export const run_remove_plugins_workspace_installations_created_at = app_migrations.runner(
	internal.migrations.remove_plugins_workspace_installations_created_at,
);
export const run_remove_plugins_workspace_event_handlers_created_at = app_migrations.runner(
	internal.migrations.remove_plugins_workspace_event_handlers_created_at,
);
export const run_remove_plugins_event_runs_created_at = app_migrations.runner(
	internal.migrations.remove_plugins_event_runs_created_at,
);
export const run_remove_plugins_event_run_calls_created_at = app_migrations.runner(
	internal.migrations.remove_plugins_event_run_calls_created_at,
);
export const run_backfill_plugins_version_reviews_updated_at = app_migrations.runner(
	internal.migrations.backfill_plugins_version_reviews_updated_at,
);
export const run_backfill_plugins_versions_is_latest = app_migrations.runner(
	internal.migrations.backfill_plugins_versions_is_latest,
);
