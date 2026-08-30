import { Migrations } from "@convex-dev/migrations";
import { getFunctionName } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Doc, Id, TableNames } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { quotas } from "../shared/quotas.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { access_control_db_ensure_organization_member_role } from "./access_control.ts";
import { files_merge_contiguous_chunks } from "./files_nodes.ts";
import {
	plugins_data_MAX_COLLECTIONS,
	plugins_data_db_ensure_scope_identity,
	plugins_data_db_get_scope_access_state,
	plugins_data_db_keep_scope_managed,
	plugins_data_max_last_append,
	plugins_data_parse_append_key_at,
} from "./plugins_data.ts";
import { plugins_PRIVATE_FOLDER_ROLLOVER_INDEX } from "./plugins_projections.ts";

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
	| "plugins_event_runs";

type PluginsDocWithLegacyCreatedAt<TableName extends PluginsLegacyCreatedAtTable> = Doc<TableName> & {
	createdAt?: number;
};

type LegacyVersionReview = Omit<Doc<"plugins_version_reviews">, "updatedAt"> & {
	createdAt?: number;
	updatedAt?: number;
};

type LegacyPluginsVersion = Omit<Doc<"plugins_versions">, "backend"> & {
	/** Renamed to backendEntrypointFile; docs were copied over then stripped. */
	backend?: Doc<"plugins_versions">["backendEntrypointFile"];
};

type LegacyPluginsVersionUnusedFields = Doc<"plugins_versions"> & {
	/** Removed: unread publish/source-snapshot bookkeeping. */
	sourceDefaultBranch?: string;
	sourceFileCount?: number;
	sourceTotalBytes?: number;
};

type LegacyPluginsEventHandlerStatus = Omit<Doc<"plugins_workspace_event_handlers">, "status"> & {
	/** Removed: never toggled after insert; installation.status is the authoritative enable state. */
	status?: "enabled" | "disabled";
};

type LegacyPluginsPublisherSecretAllowedOrigins = Omit<
	Doc<"plugins_publisher_repository_secrets">,
	"allowedOrigins"
> & {
	/** Removed: outbound origins come solely from the version manifest, consented at install. */
	allowedOrigins?: string[];
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
	| "files_text_chunks"
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

type LegacyFilesR2AssetConversionWorkId = Omit<Doc<"files_r2_assets">, "conversionWorkId"> & {
	/** Renamed to processingWorkId: it gates the whole post-upload pipeline, not just content conversion. */
	conversionWorkId?: Doc<"files_r2_assets">["processingWorkId"];
};

type RebrandCleanupTableName = Exclude<TableNames, "users" | "users_anagraphics">;

const rebrand_cleanup_tables = [
	"access_control_permission_grants",
	"access_control_role_assignments",
	"access_control_roles",
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
	"files_text_chunks",
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
	"github_mounts",
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

		const now = Date.now();
		await ctx.db.insert("organizations_workspaces_users", {
			organizationId: membership.organizationId,
			workspaceId: defaultWorkspaceId,
			userId: membership.userId,
			active: true,
			updatedAt: now,
		});

		// A membership alone gives no permission, so the repaired membership also needs the role that
		// carries the organization-wide permissions.
		await access_control_db_ensure_organization_member_role(ctx, {
			organization,
			workspaceId: defaultWorkspaceId,
			userId: membership.userId,
			now,
		});
	},
});

/**
 * Give every active membership the role it needs to keep working.
 *
 * Before the permission rework, having a membership was enough to read and write files. Now the
 * permissions come from the role assignment. So a membership written by the old code would quietly
 * lose access: the file tree would load empty instead of showing an error. Owners are skipped,
 * because being in `organizations.ownerUserId` already gives them everything.
 *
 * Safe to run again: `access_control_db_ensure_organization_member_role` keeps an existing assignment, so it
 * never overwrites a role somebody set on purpose.
 */
export const backfill_access_control_member_assignments = app_migrations.define({
	table: "organizations_workspaces_users",
	migrateOne: async (ctx, membership) => {
		if (membership.active === false) {
			return;
		}

		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization) {
			return;
		}

		await access_control_db_ensure_organization_member_role(ctx, {
			organization,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			now: Date.now(),
		});
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

export const rename_text_chunks_file_node_id = app_migrations.define({
	table: "files_text_chunks",
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

export const rename_files_r2_assets_conversion_work_id = app_migrations.define({
	table: "files_r2_assets",
	migrateOne: async (ctx, asset) => {
		const legacyAsset = asset as LegacyFilesR2AssetConversionWorkId;
		// `in` check: the stored value may legitimately be null, which is a settled state to copy over.
		if (!("conversionWorkId" in legacyAsset)) {
			return;
		}

		const { _id, _creationTime, conversionWorkId, ...next } = legacyAsset;
		await ctx.db.replace("files_r2_assets", _id, { ...next, processingWorkId: conversionWorkId });
	},
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

/** Existing threads predate the read cursor; treat their history as already read. */
export const backfill_ai_chat_threads_read_at = app_migrations.define({
	table: "ai_chat_threads",
	migrateOne: async (ctx, thread) => {
		if (thread.readAt !== undefined || thread.lastMessageAt === undefined) {
			return;
		}

		await ctx.db.patch("ai_chat_threads", thread._id, { readAt: thread.lastMessageAt });
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

export const remove_plugins_workspace_event_handlers_status = app_migrations.define({
	table: "plugins_workspace_event_handlers",
	migrateOne: async (ctx, handler) => {
		const legacyHandler = handler as LegacyPluginsEventHandlerStatus;
		if (legacyHandler.status === undefined) {
			return;
		}

		const { _id, _creationTime, status: _status, ...next } = legacyHandler;
		await ctx.db.replace("plugins_workspace_event_handlers", _id, next);
	},
});

export const remove_plugins_publisher_repository_secrets_allowed_origins = app_migrations.define({
	table: "plugins_publisher_repository_secrets",
	migrateOne: async (ctx, secret) => {
		const legacySecret = secret as LegacyPluginsPublisherSecretAllowedOrigins;
		if (legacySecret.allowedOrigins === undefined) {
			return;
		}

		const { _id, _creationTime, allowedOrigins: _allowedOrigins, ...next } = legacySecret;
		await ctx.db.replace("plugins_publisher_repository_secrets", _id, next);
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

async function plugins_versions_normalize_is_latest(ctx: MutationCtx, version: Doc<"plugins_versions">) {
	// Use ready time because a failed older row can finish after a newer row.
	const [latestReady, markedVersions] = await Promise.all([
		ctx.db
			.query("plugins_versions")
			.withIndex("by_name_sourceStatus_updatedAt", (q) => q.eq("name", version.name).eq("sourceStatus", "ready"))
			.order("desc")
			.first(),
		ctx.db
			.query("plugins_versions")
			.withIndex("by_isLatest_name", (q) => q.eq("isLatest", true).eq("name", version.name))
			.collect(),
	]);
	// Old rows can share a millisecond. Keep the valid marker when it is inside the newest tie.
	const markedLatestInTie = latestReady
		? markedVersions.find(
				(markedVersion) => markedVersion.sourceStatus === "ready" && markedVersion.updatedAt === latestReady.updatedAt,
			)
		: undefined;
	const latestVersion = markedLatestInTie ?? latestReady;

	// A batch can stop after this doc. Normalize every marker for the plugin before this transaction commits.
	await Promise.all([
		...markedVersions
			.filter((markedVersion) => markedVersion._id !== latestVersion?._id)
			.map((markedVersion) => ctx.db.patch("plugins_versions", markedVersion._id, { isLatest: false })),
		...(latestVersion && !latestVersion.isLatest
			? [ctx.db.patch("plugins_versions", latestVersion._id, { isLatest: true })]
			: []),
	]);
}

export const backfill_plugins_versions_is_latest = app_migrations.define({
	table: "plugins_versions",
	batchSize: 20,
	migrateOne: plugins_versions_normalize_is_latest,
});

// Use a new migration name because the component skips an old migration after it is complete.
export const repair_plugins_versions_is_latest = app_migrations.define({
	table: "plugins_versions",
	batchSize: 20,
	migrateOne: plugins_versions_normalize_is_latest,
});

export const backfill_plugins_versions_backend_entrypoint_file = app_migrations.define({
	table: "plugins_versions",
	migrateOne: async (ctx, version) => {
		// The backend pointer was renamed backendEntrypointFile; copy it over verbatim (null included).
		const legacy = version as LegacyPluginsVersion;
		if (legacy.backendEntrypointFile !== undefined || legacy.backend === undefined) {
			return;
		}

		await ctx.db.patch("plugins_versions", version._id, { backendEntrypointFile: legacy.backend });
	},
});

export const remove_plugins_versions_backend = app_migrations.define({
	table: "plugins_versions",
	migrateOne: async (ctx, version) => {
		const legacy = version as LegacyPluginsVersion;
		if (legacy.backend === undefined) {
			return;
		}

		const { _id, _creationTime, backend: _backend, ...next } = legacy;
		await ctx.db.replace("plugins_versions", _id, next);
	},
});

export const remove_plugins_versions_unused_fields = app_migrations.define({
	table: "plugins_versions",
	migrateOne: async (ctx, version) => {
		const legacy = version as LegacyPluginsVersionUnusedFields;
		if (
			legacy.sourceDefaultBranch === undefined &&
			legacy.sourceFileCount === undefined &&
			legacy.sourceTotalBytes === undefined
		) {
			return;
		}

		const {
			_id,
			_creationTime,
			sourceDefaultBranch: _sourceDefaultBranch,
			sourceFileCount: _sourceFileCount,
			sourceTotalBytes: _sourceTotalBytes,
			...next
		} = legacy;
		await ctx.db.replace("plugins_versions", _id, next);
	},
});

export const backfill_plugins_versions_backend_entrypoint_file_sha256 = app_migrations.define({
	table: "plugins_versions",
	migrateOne: async (ctx, version) => {
		const backendEntrypointFile = version.backendEntrypointFile;
		if (backendEntrypointFile === null || backendEntrypointFile.sha256 !== undefined) {
			return;
		}

		const backendEntrypointListedFile = version.files.find((file) => file.r2Key === backendEntrypointFile.r2Key);
		if (backendEntrypointListedFile === undefined) {
			return;
		}

		await ctx.db.patch("plugins_versions", version._id, {
			backendEntrypointFile: { ...backendEntrypointFile, sha256: backendEntrypointListedFile.sha256 },
		});
	},
});

/**
 * Existing versions were published before a plugin page could declare its own outbound origins.
 * Their manifests could not name any, so the empty list is what a republish of the same commit
 * would produce. The field is required again once this backfill has run.
 */
export const backfill_plugins_versions_ui_outbound_origins = app_migrations.define({
	table: "plugins_versions",
	migrateOne: async (ctx, version) => {
		if (version.uiOutboundOrigins !== undefined) {
			return;
		}

		await ctx.db.patch("plugins_versions", version._id, { uiOutboundOrigins: [] });
	},
});

/**
 * The install-side record of the same consent. These installs were accepted before a page could
 * declare outbound origins, so the workspace agreed to none.
 */
export const backfill_plugins_installations_accepted_ui_origins = app_migrations.define({
	table: "plugins_workspace_installations",
	migrateOne: async (ctx, installation) => {
		if (installation.acceptedUiOutboundOrigins !== undefined) {
			return;
		}

		await ctx.db.patch("plugins_workspace_installations", installation._id, { acceptedUiOutboundOrigins: [] });
	},
});

/**
 * Attributes the documents that were stored before the per-member share existed. Those rows carry no
 * `chargedTo`, so their bytes and slots sit in the installation total and in nobody's share. Until
 * this runs, the per-member ceilings do nothing on any installation that already holds documents: a
 * member can have composed a full store and still read zero against their own share.
 *
 * Who they belong to is decided the same way a live write decides it — the member who composed the
 * value. So the row's `createdBy` becomes its `chargedTo`, and `machineBytes` becomes 0 because no
 * plugin backend can be shown to have written any of those bytes.
 *
 * Live writes patch the same member rows while this runs, so each document is read, changed, and
 * written inside its own batch transaction. A document that already carries `chargedTo` is skipped.
 * That is what makes a second run cost nothing and lets an interrupted run pick up where it stopped.
 */
export const backfill_plugins_data_charged_to = app_migrations.define({
	table: "plugins_data",
	migrateOne: async (ctx, document) => {
		if (document.chargedTo !== undefined) {
			return;
		}

		const existing = await ctx.db
			.query("plugins_data_member_usage")
			.withIndex("by_installation_user", (q) =>
				q.eq("installationId", document.installationId).eq("userId", document.createdBy),
			)
			.unique();
		let memberUsageId: Id<"plugins_data_member_usage">;
		if (!existing) {
			memberUsageId = await ctx.db.insert("plugins_data_member_usage", {
				organizationId: document.organizationId,
				workspaceId: document.workspaceId,
				installationId: document.installationId,
				userId: document.createdBy,
				generation: "document_bound",
				usedBytes: document.byteSize,
				usedDocuments: 1,
				machineBytes: 0,
				collectionNames: [document.collection],
			});
		} else {
			memberUsageId = existing._id;
			await ctx.db.patch("plugins_data_member_usage", existing._id, {
				generation: "document_bound",
				usedBytes: existing.usedBytes + document.byteSize,
				usedDocuments: existing.usedDocuments + 1,
				collectionNames: existing.collectionNames.includes(document.collection)
					? existing.collectionNames
					: [...existing.collectionNames, document.collection],
			});
		}

		await ctx.db.patch("plugins_data", document._id, {
			chargedTo: document.createdBy,
			chargedToMemberUsageId: memberUsageId,
			machineBytes: 0,
		});
	},
});

/**
 * The first half of the per-member rollback. It clears both attribution fields from every surviving
 * document, so the schema push that drops them finds no row still carrying one.
 *
 * Run this only after a push that stopped writing those fields. The strip and a live write would
 * otherwise take turns, and the schema push after it would fail on whatever the last write put back.
 */
export const remove_plugins_data_charged_to_and_machine_bytes = app_migrations.define({
	table: "plugins_data",
	migrateOne: async (ctx, document) => {
		if (
			document.chargedTo === undefined &&
			document.chargedToMemberUsageId === undefined &&
			document.machineBytes === undefined
		) {
			return;
		}

		await ctx.db.patch("plugins_data", document._id, {
			chargedTo: undefined,
			chargedToMemberUsageId: undefined,
			machineBytes: undefined,
		});
	},
});

/**
 * The second half of the same rollback. The per-member counters live in their own table, so there is
 * no field to strip: the rows themselves go. The migration component walks the table in batches, so
 * one enormous transaction never has to hold the whole table.
 */
export const delete_plugins_data_member_usage = app_migrations.define({
	table: "plugins_data_member_usage",
	migrateOne: async (ctx, usage) => {
		await ctx.db.delete("plugins_data_member_usage", usage._id);
	},
});

/**
 * Drop counter rows from before documents named their exact counter generation. Their documents
 * stay uncharged until a member writes them again, which safely starts a fresh generation.
 */
export const delete_legacy_plugins_data_member_usage = app_migrations.define({
	table: "plugins_data_member_usage",
	migrateOne: async (ctx, usage) => {
		if (usage.generation === "document_bound") {
			return;
		}

		await ctx.db.delete("plugins_data_member_usage", usage._id);
	},
});

function migrations_plugin_scope_append_sequence_is_valid(
	value: number | undefined,
	minimum: number,
): value is number {
	return value !== undefined && Number.isSafeInteger(value) && value >= minimum;
}

function migrations_plugin_scope_append_state_is_defaulted(
	scope: Pick<Doc<"plugins_data_scopes">, "lastAppend" | "appendSequence">,
) {
	if (scope.lastAppend === undefined) {
		return false;
	}
	return scope.lastAppend === null
		? scope.appendSequence === 0
		: migrations_plugin_scope_append_sequence_is_valid(scope.appendSequence, 1);
}

/** Preserve the newest accepted scoped append before old scope rows receive a default marker. */
export const backfill_plugin_scope_last_append_from_documents = app_migrations.define({
	table: "plugins_data",
	batchSize: 20,
	migrateOne: async (ctx, document) => {
		if (document.scopeId === undefined || document.userWriteRequestId === undefined) {
			return;
		}
		const scopeId = document.scopeId;
		const at = plugins_data_parse_append_key_at(document.key);
		if (at === null) {
			return;
		}

		// A released scope has no live row. Never turn retained private history into live activity.
		const scopes = await ctx.db
			.query("plugins_data_scopes")
			.withIndex("by_installation_scope", (q) =>
				q.eq("installationId", document.installationId).eq("scopeId", scopeId),
			)
			.take(plugins_data_MAX_COLLECTIONS);
		const scope = scopes.find(
			(row) => row.collection === document.collection && document.key.startsWith(row.keyPrefix),
		);
		if (!scope) {
			return;
		}

		const lastAppend = plugins_data_max_last_append(scope.lastAppend, {
			at,
			key: document.key,
			createdByUserId: document.createdBy,
		});
		// Old rows prove at least one append, but not the exact count. Never lower a live counter.
		const appendSequence = migrations_plugin_scope_append_sequence_is_valid(scope.appendSequence, 1)
			? scope.appendSequence
			: 1;
		if (lastAppend !== scope.lastAppend || appendSequence !== scope.appendSequence) {
			await ctx.db.patch("plugins_data_scopes", scope._id, { lastAppend, appendSequence });
		}
	},
});

/** Give every old live scope row explicit append defaults after append history was preserved. */
export const default_plugin_scope_last_append = app_migrations.define({
	table: "plugins_data_scopes",
	batchSize: 20,
	migrateOne: async (ctx, scope) => {
		const lastAppend = scope.lastAppend ?? null;
		const appendSequence =
			lastAppend === null
				? 0
				: migrations_plugin_scope_append_sequence_is_valid(scope.appendSequence, 1)
					? scope.appendSequence
					: 1;
		if (lastAppend !== scope.lastAppend || appendSequence !== scope.appendSequence) {
			await ctx.db.patch("plugins_data_scopes", scope._id, { lastAppend, appendSequence });
		}
	},
});

const CHITCHAT_PRIVATE_SCOPE_COLLECTIONS = new Set(["channels", "messages", "replies", "reactions"]);
const CHITCHAT_PRIVATE_SCOPE_ID_PATTERN =
	/^p\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Recover private ranges from Chitchat documents left by the old scope delete.
 *
 * Chitchat uses its scope id as the exact key prefix in all four private collections. No other
 * plugin contract proves a missing prefix, so an unknown orphan blocks this rollout for an explicit
 * migrate-or-erase choice instead of guessing and exposing private history.
 */
export const recover_or_audit_orphan_plugin_scope_ranges = app_migrations.define({
	table: "plugins_data",
	batchSize: 20,
	migrateOne: async (ctx, document) => {
		if (document.scopeId === undefined) {
			return;
		}
		const scopeId = document.scopeId;

		const [liveScope, releasedFence] = await Promise.all([
			ctx.db
				.query("plugins_data_scopes")
				.withIndex("by_installation_scope", (q) =>
					q.eq("installationId", document.installationId).eq("scopeId", scopeId),
				)
				.first(),
			ctx.db
				.query("plugins_data_released_scope_ranges")
				.withIndex("by_installation_scope", (q) =>
					q.eq("installationId", document.installationId).eq("scopeId", scopeId),
				)
				.filter((q) =>
					q.or(q.neq(q.field("collectionName"), ""), q.neq(q.field("keyPrefix"), "")),
				)
				.first(),
		]);
		if (liveScope) {
			return;
		}

		const installation = await ctx.db.get("plugins_workspace_installations", document.installationId);
		const isValidChitchatDocument =
			installation?.pluginName === "chitchat" &&
			document.pluginName === "chitchat" &&
			document.organizationId === installation.organizationId &&
			document.workspaceId === installation.workspaceId &&
			CHITCHAT_PRIVATE_SCOPE_COLLECTIONS.has(document.collection) &&
			CHITCHAT_PRIVATE_SCOPE_ID_PATTERN.test(scopeId) &&
			(document.key === scopeId || document.key.startsWith(`${scopeId}:`));
		// Keep auditing Chitchat after an earlier row recovered this scope. A later malformed row in
		// the same migration page must still stop the rollout instead of hiding behind the new fence.
		if (releasedFence) {
			if (installation?.pluginName === "chitchat" && !isValidChitchatDocument) {
				throw new Error(
					"Plugin scope recovery blocked: choose how to migrate or erase a malformed Chitchat orphan",
				);
			}
			return;
		}
		if (!installation || installation.pluginName !== "chitchat") {
			throw new Error(
				"Plugin scope recovery blocked: choose how to migrate or erase an orphan scoped document outside Chitchat",
			);
		}
		if (!isValidChitchatDocument) {
			throw new Error(
				"Plugin scope recovery blocked: choose how to migrate or erase a malformed Chitchat orphan",
			);
		}

		for (const collectionName of CHITCHAT_PRIVATE_SCOPE_COLLECTIONS) {
			const existing = await ctx.db
				.query("plugins_data_released_scope_ranges")
				.withIndex("by_installation_collection_prefix", (q) =>
					q
						.eq("installationId", installation._id)
						.eq("collectionName", collectionName)
						.eq("keyPrefix", scopeId),
				)
				.first();
			if (existing && existing.scopeId !== scopeId) {
				throw new Error(
					"Plugin scope recovery blocked: a Chitchat orphan range belongs to another scope id",
				);
			}
			if (!existing) {
				await ctx.db.insert("plugins_data_released_scope_ranges", {
					organizationId: document.organizationId,
					workspaceId: document.workspaceId,
					installationId: document.installationId,
					scopeId,
					collectionName,
					keyPrefix: scopeId,
				});
			}
		}

		await plugins_data_db_ensure_scope_identity(ctx, { ...document, scopeId });
	},
});

/** Reserve every scope id that was live before scope creation started writing identity markers. */
export const backfill_plugin_scope_identities_from_live_scopes = app_migrations.define({
	table: "plugins_data_scopes",
	batchSize: 20,
	migrateOne: async (ctx, scope) => {
		await plugins_data_db_ensure_scope_identity(ctx, scope);
	},
});

/** Reserve every released scope id that predates the empty identity-marker row. */
export const backfill_plugin_scope_identities_from_released_ranges = app_migrations.define({
	table: "plugins_data_released_scope_ranges",
	batchSize: 20,
	migrateOne: async (ctx, releasedRange) => {
		if (releasedRange.collectionName === "" && releasedRange.keyPrefix === "") {
			return;
		}

		await plugins_data_db_ensure_scope_identity(ctx, releasedRange);
	},
});

const PLUGIN_SCOPE_AUDIT_PAGE_SIZE = 20;

async function migrations_plugin_scope_for_append(
	ctx: QueryCtx,
	document: Pick<
		Doc<"plugins_data">,
		"installationId" | "scopeId" | "collection" | "key"
	>,
) {
	if (document.scopeId === undefined) {
		return null;
	}
	const scopeId = document.scopeId;
	const scopes = await ctx.db
		.query("plugins_data_scopes")
		.withIndex("by_installation_scope", (q) =>
			q.eq("installationId", document.installationId).eq("scopeId", scopeId),
		)
		.take(plugins_data_MAX_COLLECTIONS);
	return (
		scopes.find((row) => row.collection === document.collection && document.key.startsWith(row.keyPrefix)) ?? null
	);
}

function migrations_plugin_scope_installation_id(
	ctx: QueryCtx | MutationCtx,
	grant: Pick<Doc<"access_control_permission_grants">, "resourceKind" | "resourceId">,
) {
	if (grant.resourceKind !== "plugin_scope") {
		return null;
	}

	const separator = grant.resourceId.indexOf(":");
	if (separator < 1) {
		return null;
	}

	// This is a whole-table walk, so malformed ids and unrelated grants must be harmless.
	return ctx.db.normalizeId("plugins_workspace_installations", grant.resourceId.slice(0, separator));
}

/** Remove grants whose valid installation id no longer names an installation. */
export const delete_orphan_plugin_scope_grants = app_migrations.define({
	table: "access_control_permission_grants",
	batchSize: PLUGIN_SCOPE_AUDIT_PAGE_SIZE,
	migrateOne: async (ctx, grant) => {
		const installationId = migrations_plugin_scope_installation_id(ctx, grant);
		if (!installationId || (await ctx.db.get("plugins_workspace_installations", installationId))) {
			return;
		}

		await ctx.db.delete("access_control_permission_grants", grant._id);
	},
});

/** Remove dead-installation scopes, release empty scopes, and restore one active manager. */
export const delete_stranded_plugin_data_scopes = app_migrations.define({
	table: "plugins_data_scopes",
	batchSize: PLUGIN_SCOPE_AUDIT_PAGE_SIZE,
	migrateOne: async (ctx, scope) => {
		// One logical scope may straddle two migration pages. Always load and change all collection
		// rows together so a grant added between pages cannot leave half the scope live.
		const scopes = await ctx.db
			.query("plugins_data_scopes")
			.withIndex("by_installation_scope", (q) =>
				q.eq("installationId", scope.installationId).eq("scopeId", scope.scopeId),
			)
			.take(PLUGIN_SCOPE_AUDIT_PAGE_SIZE);
		const [first] = scopes;
		if (!first) {
			return;
		}

		const installation = await ctx.db.get("plugins_workspace_installations", scope.installationId);
		if (!installation) {
			// No authorized write door remains, so a dead installation needs neither a fence nor a sync.
			await Promise.all(scopes.map((scopeRow) => ctx.db.delete("plugins_data_scopes", scopeRow._id)));
			return;
		}

		const managed = await plugins_data_db_keep_scope_managed(ctx, {
			installation,
			scopes,
		});
		if (managed.promoted) {
			// Keep a healthy scope stable. Only a repair that changed access gets a new revision.
			const membershipRevision = Math.max(Date.now(), ...scopes.map((scope) => scope.updatedAt + 1));
			await Promise.all(
				scopes.map((scope) => ctx.db.patch("plugins_data_scopes", scope._id, { updatedAt: membershipRevision })),
			);
		}
	},
});

export const audit_orphan_plugin_scope_grants_page = internalQuery({
	args: { cursor: v.union(v.null(), v.string()) },
	returns: v.object({ candidateCount: v.number(), continueCursor: v.string(), isDone: v.boolean() }),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("access_control_permission_grants")
			.paginate({ cursor: args.cursor, numItems: PLUGIN_SCOPE_AUDIT_PAGE_SIZE });
		let candidateCount = 0;
		for (const grant of page.page) {
			const installationId = migrations_plugin_scope_installation_id(ctx, grant);
			if (installationId && !(await ctx.db.get("plugins_workspace_installations", installationId))) {
				candidateCount += 1;
			}
		}
		return { candidateCount, continueCursor: page.continueCursor, isDone: page.isDone };
	},
});

export const audit_stranded_plugin_data_scopes_page = internalQuery({
	args: { cursor: v.union(v.null(), v.string()) },
	returns: v.object({ candidateCount: v.number(), continueCursor: v.string(), isDone: v.boolean() }),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("plugins_data_scopes")
			.paginate({ cursor: args.cursor, numItems: PLUGIN_SCOPE_AUDIT_PAGE_SIZE });
		let candidateCount = 0;
		for (const scope of page.page) {
			const installation = await ctx.db.get("plugins_workspace_installations", scope.installationId);
			if (!installation) {
				candidateCount += 1;
				continue;
			}
			const access = await plugins_data_db_get_scope_access_state(ctx, {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				resourceId: `${scope.installationId}:${scope.scopeId}`,
			});
			if (access.activeUserIds.length === 0 || !access.hasActiveManager) {
				candidateCount += 1;
			}
		}
		return { candidateCount, continueCursor: page.continueCursor, isDone: page.isDone };
	},
});

/** Find old append rows whose live collection marker still does not cover them. */
export const audit_plugin_scope_append_activity_page = internalQuery({
	args: { cursor: v.union(v.null(), v.string()) },
	returns: v.object({ candidateCount: v.number(), continueCursor: v.string(), isDone: v.boolean() }),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("plugins_data")
			.paginate({ cursor: args.cursor, numItems: PLUGIN_SCOPE_AUDIT_PAGE_SIZE });
		let candidateCount = 0;
		for (const document of page.page) {
			if (document.scopeId === undefined || document.userWriteRequestId === undefined) {
				continue;
			}
			const at = plugins_data_parse_append_key_at(document.key);
			if (at === null) {
				continue;
			}
			const scope = await migrations_plugin_scope_for_append(ctx, document);
			if (
				scope &&
				(plugins_data_max_last_append(scope.lastAppend, {
					at,
					key: document.key,
					createdByUserId: document.createdBy,
				}) !== scope.lastAppend ||
					!migrations_plugin_scope_append_sequence_is_valid(scope.appendSequence, 1))
			) {
				candidateCount += 1;
			}
		}
		return { candidateCount, continueCursor: page.continueCursor, isDone: page.isDone };
	},
});

/** Find live scope rows with missing, invalid, or inconsistent append defaults. */
export const audit_plugin_scope_last_append_defaults_page = internalQuery({
	args: { cursor: v.union(v.null(), v.string()) },
	returns: v.object({ candidateCount: v.number(), continueCursor: v.string(), isDone: v.boolean() }),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("plugins_data_scopes")
			.paginate({ cursor: args.cursor, numItems: PLUGIN_SCOPE_AUDIT_PAGE_SIZE });
		return {
			candidateCount: page.page.filter((scope) => !migrations_plugin_scope_append_state_is_defaulted(scope)).length,
			continueCursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

/** Stamp one legacy private projection only after its map, locks, scope, and readers still agree. */
export const migrate_proved_projection_private_folder_authority = internalMutation({
	args: { projectionFileId: v.id("plugins_data_projection_files") },
	returns: v.object({ migrated: v.boolean() }),
	handler: async (ctx, args) => {
		const projectionFile = await ctx.db.get("plugins_data_projection_files", args.projectionFileId);
		if (!projectionFile || projectionFile.rolloverIndex !== plugins_PRIVATE_FOLDER_ROLLOVER_INDEX) {
			throw new Error("Expected one legacy Chitchat private-folder map");
		}

		const [installation, state, folder] = await Promise.all([
			ctx.db.get("plugins_workspace_installations", projectionFile.installationId),
			ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", projectionFile.installationId))
				.first(),
			ctx.db.get("files_nodes", projectionFile.fileNodeId),
		]);
		const root = state?.rootFolderNodeId ? await ctx.db.get("files_nodes", state.rootFolderNodeId) : null;
		const [activeRoot, activeFolder] = await Promise.all([
			root
				? ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
							q
								.eq("organizationId", projectionFile.organizationId)
								.eq("workspaceId", projectionFile.workspaceId)
								.eq("path", root.path)
								.eq("archiveOperationId", undefined),
						)
						.first()
				: null,
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", projectionFile.organizationId)
						.eq("workspaceId", projectionFile.workspaceId)
						.eq("path", projectionFile.path)
						.eq("archiveOperationId", undefined),
				)
				.first(),
		]);
		const provedNodes =
			installation?.pluginName === "chitchat" &&
			installation.organizationId === projectionFile.organizationId &&
			installation.workspaceId === projectionFile.workspaceId &&
			state?.pluginName === "chitchat" &&
			state.organizationId === projectionFile.organizationId &&
			state.workspaceId === projectionFile.workspaceId &&
			root !== null &&
			activeRoot?._id === root._id &&
			root.kind === "folder" &&
			root.readOnlyScopeNodeId === root._id &&
			(root.projectionPluginName === undefined || root.projectionPluginName === "chitchat") &&
			folder !== null &&
			activeFolder?._id === folder._id &&
			folder.kind === "folder" &&
			folder.readOnlyScopeNodeId === root._id &&
			folder.restrictedScopeNodeId === folder._id &&
			(folder.projectionPluginName === undefined || folder.projectionPluginName === "chitchat");
		if (!provedNodes) {
			throw new Error("Legacy Chitchat private-folder authority is not proved");
		}

		const scopes = await ctx.db
			.query("plugins_data_scopes")
			.withIndex("by_installation_scope", (q) =>
				q.eq("installationId", projectionFile.installationId).eq("scopeId", projectionFile.channelKey),
			)
			.take(plugins_data_MAX_COLLECTIONS + 1);
		if (
			scopes.length === 0 ||
			scopes.length > plugins_data_MAX_COLLECTIONS ||
			scopes.some(
				(scope) =>
					scope.organizationId !== projectionFile.organizationId ||
					scope.workspaceId !== projectionFile.workspaceId ||
					scope.keyPrefix !== projectionFile.channelKey,
			)
		) {
			throw new Error("Legacy Chitchat private-folder scope is not proved");
		}

		const scopeResourceId = `${projectionFile.installationId}:${projectionFile.channelKey}`;
		const [scopeGrants, folderGrants] = await Promise.all([
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_workspace_resource_user_permission", (q) =>
					q
						.eq("organizationId", projectionFile.organizationId)
						.eq("workspaceId", projectionFile.workspaceId)
						.eq("resourceKind", "plugin_scope")
						.eq("resourceId", scopeResourceId),
				)
				.take(101),
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_workspace_resource_user_permission", (q) =>
					q
						.eq("organizationId", projectionFile.organizationId)
						.eq("workspaceId", projectionFile.workspaceId)
						.eq("resourceKind", "file")
						.eq("resourceId", String(folder._id)),
				)
				.take(101),
		]);
		if (scopeGrants.length > 100 || folderGrants.length > 100) {
			throw new Error("Legacy Chitchat private-folder grant proof is too large");
		}
		if (
			scopeGrants.length === 0 ||
			scopeGrants.some((grant) => grant.principalKind !== "user" || grant.userId === undefined)
		) {
			throw new Error("Legacy Chitchat private-folder readers are not proved");
		}
		const expectedUsers = new Set(scopeGrants.flatMap((grant) => (grant.userId ? [grant.userId] : [])));
		const actualUsers = new Set<Id<"users">>();
		for (const grant of folderGrants) {
			if (
				grant.principalKind !== "user" ||
				grant.userId === undefined ||
				grant.permission !== "content.read" ||
				actualUsers.has(grant.userId)
			) {
				throw new Error("Legacy Chitchat private-folder readers are not proved");
			}
			actualUsers.add(grant.userId);
		}
		if (expectedUsers.size !== actualUsers.size || [...expectedUsers].some((userId) => !actualUsers.has(userId))) {
			throw new Error("Legacy Chitchat private-folder readers are not proved");
		}

		const migrated = root.projectionPluginName !== "chitchat" || folder.projectionPluginName !== "chitchat";
		await Promise.all([
			ctx.db.patch("files_nodes", root._id, { projectionPluginName: "chitchat" }),
			ctx.db.patch("files_nodes", folder._id, { projectionPluginName: "chitchat" }),
		]);
		return { migrated };
	},
});

/** Prove every surviving member counter uses exact document-bound generations. */
export const audit_legacy_plugins_data_member_usage_page = internalQuery({
	args: { cursor: v.union(v.null(), v.string()) },
	returns: v.object({ candidateCount: v.number(), continueCursor: v.string(), isDone: v.boolean() }),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("plugins_data_member_usage")
			.paginate({ cursor: args.cursor, numItems: PLUGIN_SCOPE_AUDIT_PAGE_SIZE });
		return {
			candidateCount: page.page.filter((usage) => usage.generation !== "document_bound").length,
			continueCursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

/**
 * Stop before changing any projection pointer when a private-folder map is not proved. The map is
 * the only durable link to its mirrored file grants, so removing it would make later ACL cleanup
 * unable to find the old folder.
 */
export const audit_projection_private_folder_authority = app_migrations.define({
	table: "plugins_data_projection_files",
	batchSize: 20,
	migrateOne: async (ctx, projectionFile) => {
		if (projectionFile.rolloverIndex !== plugins_PRIVATE_FOLDER_ROLLOVER_INDEX) {
			return;
		}

		const installation = await ctx.db.get("plugins_workspace_installations", projectionFile.installationId);
		const state = await ctx.db
			.query("plugins_data_projection_states")
			.withIndex("by_installation", (q) => q.eq("installationId", projectionFile.installationId))
			.first();
		const root = state?.rootFolderNodeId ? await ctx.db.get("files_nodes", state.rootFolderNodeId) : null;
		const node = await ctx.db.get("files_nodes", projectionFile.fileNodeId);
		const active = node
			? await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", projectionFile.organizationId)
							.eq("workspaceId", projectionFile.workspaceId)
							.eq("path", projectionFile.path)
							.eq("archiveOperationId", undefined),
					)
					.first()
			: null;
		const trusted =
			installation?.pluginName === "chitchat" &&
			installation.organizationId === projectionFile.organizationId &&
			installation.workspaceId === projectionFile.workspaceId &&
			state?.pluginName === "chitchat" &&
			state.organizationId === projectionFile.organizationId &&
			state.workspaceId === projectionFile.workspaceId &&
			root !== null &&
			root.organizationId === projectionFile.organizationId &&
			root.workspaceId === projectionFile.workspaceId &&
			root.kind === "folder" &&
			root.archiveOperationId === undefined &&
			root.projectionPluginName === "chitchat" &&
			root.readOnlyScopeNodeId === root._id &&
			node !== null &&
			active?._id === node._id &&
			node.organizationId === projectionFile.organizationId &&
			node.workspaceId === projectionFile.workspaceId &&
			node.kind === "folder" &&
			node.projectionPluginName === "chitchat" &&
			node.readOnlyScopeNodeId === root._id &&
			node.restrictedScopeNodeId === node._id;
		if (!trusted) {
			throw new Error(
				"Projection cutover blocked: choose how to migrate or erase an unproved Chitchat private folder",
			);
		}
	},
});

/**
 * Keep only Chitchat roots already proved by the new producer stamp and direct lock. A legacy state
 * pointer is not ownership: reset it so rebuild uses a collision path and leaves that folder live.
 * Council roots are shared workspace folders and are never stamped.
 */
export const audit_projection_root_authority = app_migrations.define({
	table: "plugins_data_projection_states",
	batchSize: 20,
	migrateOne: async (ctx, state) => {
		if (state.pluginName !== "chitchat" || state.rootFolderNodeId === undefined) {
			return;
		}

		const root = await ctx.db.get("files_nodes", state.rootFolderNodeId);
		const trusted =
			root !== null &&
			root.organizationId === state.organizationId &&
			root.workspaceId === state.workspaceId &&
			root.kind === "folder" &&
			root.archiveOperationId === undefined &&
			root.projectionPluginName === "chitchat" &&
			root.readOnlyScopeNodeId === root._id;
		if (trusted) {
			return;
		}

		console.error("Projection root authority audit reset an unproved Chitchat root", {
			rootFolderNodeId: state.rootFolderNodeId,
		});
		await ctx.db.patch("plugins_data_projection_states", state._id, {
			rootFolderNodeId: undefined,
			cursors: {},
			scanCursors: {},
			reconcileAfterChannelKey: undefined,
			dirty: true,
			syncGeneration: state.syncGeneration + 1,
			scheduledJobId: undefined,
			updatedAt: Date.now(),
		});
	},
});

/** Drop any map row whose node was not already stamped and locked by the new producer. */
export const audit_projection_file_authority = app_migrations.define({
	table: "plugins_data_projection_files",
	batchSize: 20,
	migrateOne: async (ctx, projectionFile) => {
		const installation = await ctx.db.get("plugins_workspace_installations", projectionFile.installationId);
		if (!installation || (installation.pluginName !== "chitchat" && installation.pluginName !== "council")) {
			console.error("Projection file authority audit removed a row for an unknown installation", {
				installationId: projectionFile.installationId,
			});
			await ctx.db.delete("plugins_data_projection_files", projectionFile._id);
			return;
		}

		const node = await ctx.db.get("files_nodes", projectionFile.fileNodeId);
		const state = await ctx.db
			.query("plugins_data_projection_states")
			.withIndex("by_installation", (q) => q.eq("installationId", projectionFile.installationId))
			.first();
		const active = node
			? await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", projectionFile.organizationId)
							.eq("workspaceId", projectionFile.workspaceId)
							.eq("path", projectionFile.path)
							.eq("archiveOperationId", undefined),
					)
					.first()
			: null;
		const correctLock =
			node !== null && state?.rootFolderNodeId !== undefined
				? installation.pluginName === "council"
					? node.readOnlyScopeNodeId === node._id
					: node.readOnlyScopeNodeId === state.rootFolderNodeId
				: false;
		const privateFolder = projectionFile.rolloverIndex === plugins_PRIVATE_FOLDER_ROLLOVER_INDEX;
		const trusted =
			node !== null &&
			active?._id === node._id &&
			node.organizationId === projectionFile.organizationId &&
			node.workspaceId === projectionFile.workspaceId &&
			node.projectionPluginName === installation.pluginName &&
			correctLock &&
			(privateFolder
				? installation.pluginName === "chitchat" && node.kind === "folder" && node.restrictedScopeNodeId === node._id
				: node.kind === "file" && node.nonCollaborative === true && node.assetId !== undefined);
		if (!trusted) {
			// Recheck private folders here because migration phases commit separately. If authority
			// changed after the first audit, deleting this map would orphan its mirrored file grants.
			if (privateFolder) {
				throw new Error(
					"Projection cutover blocked: choose how to migrate or erase an unproved Chitchat private folder",
				);
			}
			console.error("Projection file authority audit removed an unproved map row", {
				fileNodeId: projectionFile.fileNodeId,
			});
			await ctx.db.delete("plugins_data_projection_files", projectionFile._id);

			// Queue the channel again. Council has no full cursor reset after this audit, so deleting
			// its old map without durable dirty work would leave the missing projection file unseen.
			if (state) {
				const now = Date.now();
				await ctx.db.patch("plugins_data_projection_states", state._id, {
					dirty: true,
					updatedAt: now,
				});
				const dirty = await ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) =>
						q.eq("installationId", projectionFile.installationId).eq("channelKey", projectionFile.channelKey),
					)
					.first();
				if (dirty) {
					await ctx.db.patch("plugins_data_projection_dirty_channels", dirty._id, {
						updatedAt: Math.max(now, dirty.updatedAt + 1),
					});
				} else {
					await ctx.db.insert("plugins_data_projection_dirty_channels", {
						organizationId: projectionFile.organizationId,
						workspaceId: projectionFile.workspaceId,
						installationId: projectionFile.installationId,
						channelKey: projectionFile.channelKey,
						queuedAt: now,
						updatedAt: now,
					});
				}
			}
		}
	},
});

/**
 * Bind each projection file's normalized text hash to the asset that currently stores those bytes.
 * Run this before resetting Chitchat cursors so the cutover rebuild can skip unchanged files.
 */
export const backfill_projection_file_content_pairs = app_migrations.define({
	table: "plugins_data_projection_files",
	batchSize: 1,
	migrateOne: async (ctx, projectionFile) => {
		if (projectionFile.rolloverIndex === plugins_PRIVATE_FOLDER_ROLLOVER_INDEX) {
			return;
		}

		const fileNode = await ctx.db.get("files_nodes", projectionFile.fileNodeId);
		const installation = await ctx.db.get("plugins_workspace_installations", projectionFile.installationId);
		if (
			!fileNode ||
			!installation ||
			fileNode.kind !== "file" ||
			fileNode.assetId === undefined ||
			fileNode.projectionPluginName !== installation.pluginName
		) {
			console.error("Projection content-pair backfill skipped a missing or non-file node", {
				fileNodeId: projectionFile.fileNodeId,
			});
			return;
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		if (
			!asset ||
			asset.organizationId !== projectionFile.organizationId ||
			asset.workspaceId !== projectionFile.workspaceId
		) {
			console.error("Projection content-pair backfill skipped a missing or mismatched asset", {
				fileNodeId: projectionFile.fileNodeId,
			});
			return;
		}

		const chunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", projectionFile.organizationId)
					.eq("workspaceId", projectionFile.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", projectionFile.fileNodeId),
			)
			.collect();
		const text = chunks.length > 0 ? files_merge_contiguous_chunks(chunks) : asset.size === 0 ? "" : null;
		if (text === null) {
			console.error("Projection content-pair backfill skipped missing or non-contiguous chunks", {
				fileNodeId: projectionFile.fileNodeId,
			});
			return;
		}

		const contentHash = await crypto_sha256_hex(text);
		if (projectionFile.contentHash === contentHash && projectionFile.contentAssetId === fileNode.assetId) {
			return;
		}

		await ctx.db.patch("plugins_data_projection_files", projectionFile._id, {
			contentHash,
			contentAssetId: fileNode.assetId,
		});
	},
});

/**
 * Backfill the opaque cursor map on every projection state. Also start one clean merged-feed
 * and reconciliation cycle for Chitchat. The generation bump makes an older in-flight sync unable to clear its reset.
 */
export const reset_chitchat_projection_state_cursors = app_migrations.define({
	table: "plugins_data_projection_states",
	batchSize: 20,
	migrateOne: async (ctx, state) => {
		if (state.pluginName !== "chitchat") {
			await ctx.db.patch("plugins_data_projection_states", state._id, {
				scanCursors: {},
			});
			return;
		}

		await ctx.db.patch("plugins_data_projection_states", state._id, {
			cursors: {},
			scanCursors: {},
			reconcileAfterChannelKey: undefined,
			dirty: true,
			syncGeneration: state.syncGeneration + 1,
			scheduledJobId: undefined,
		});
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
export const run_rename_text_chunks_file_node_id = app_migrations.runner(
	internal.migrations.rename_text_chunks_file_node_id,
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
export const run_rename_files_r2_assets_conversion_work_id = app_migrations.runner(
	internal.migrations.rename_files_r2_assets_conversion_work_id,
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
export const run_remove_plugins_workspace_event_handlers_status = app_migrations.runner(
	internal.migrations.remove_plugins_workspace_event_handlers_status,
);
export const run_remove_plugins_publisher_repository_secrets_allowed_origins = app_migrations.runner(
	internal.migrations.remove_plugins_publisher_repository_secrets_allowed_origins,
);
export const run_remove_plugins_event_runs_created_at = app_migrations.runner(
	internal.migrations.remove_plugins_event_runs_created_at,
);
export const run_backfill_plugins_version_reviews_updated_at = app_migrations.runner(
	internal.migrations.backfill_plugins_version_reviews_updated_at,
);
export const run_backfill_plugins_versions_is_latest = app_migrations.runner(
	internal.migrations.backfill_plugins_versions_is_latest,
);
export const run_repair_plugins_versions_is_latest = app_migrations.runner(
	internal.migrations.repair_plugins_versions_is_latest,
);
export const run_backfill_plugins_versions_backend_entrypoint_file = app_migrations.runner(
	internal.migrations.backfill_plugins_versions_backend_entrypoint_file,
);
export const run_remove_plugins_versions_backend = app_migrations.runner(
	internal.migrations.remove_plugins_versions_backend,
);
export const run_remove_plugins_versions_unused_fields = app_migrations.runner(
	internal.migrations.remove_plugins_versions_unused_fields,
);
export const run_backfill_plugins_versions_backend_entrypoint_file_sha256 = app_migrations.runner(
	internal.migrations.backfill_plugins_versions_backend_entrypoint_file_sha256,
);
export const run_backfill_ai_chat_threads_read_at = app_migrations.runner(
	internal.migrations.backfill_ai_chat_threads_read_at,
);
export const run_backfill_plugins_versions_ui_outbound_origins = app_migrations.runner(
	internal.migrations.backfill_plugins_versions_ui_outbound_origins,
);
export const run_backfill_plugins_installations_accepted_ui_origins = app_migrations.runner(
	internal.migrations.backfill_plugins_installations_accepted_ui_origins,
);
export const run_backfill_plugins_data_charged_to = app_migrations.runner(
	internal.migrations.backfill_plugins_data_charged_to,
);
export const run_remove_plugins_data_charged_to_and_machine_bytes = app_migrations.runner(
	internal.migrations.remove_plugins_data_charged_to_and_machine_bytes,
);
export const run_delete_plugins_data_member_usage = app_migrations.runner(
	internal.migrations.delete_plugins_data_member_usage,
);
export const run_delete_legacy_plugins_data_member_usage = app_migrations.runner(
	internal.migrations.delete_legacy_plugins_data_member_usage,
);
const plugin_scope_append_activity_migrations = [
	internal.migrations.backfill_plugin_scope_last_append_from_documents,
	internal.migrations.default_plugin_scope_last_append,
];
export const run_backfill_plugin_scope_append_activity = app_migrations.runner(
	plugin_scope_append_activity_migrations,
);
// Before this series, upgrade each affected pre-fence Chitchat install to a different reviewed
// version, or get approval to uninstall, drain, and reinstall it. The same version does not revoke
// old sessions, and an empty deleted scope leaves no row to recover. Close orphan ranges first.
export const run_backfill_plugin_scope_identity_markers = app_migrations.runner([
	internal.migrations.recover_or_audit_orphan_plugin_scope_ranges,
	internal.migrations.backfill_plugin_scope_identities_from_live_scopes,
	internal.migrations.backfill_plugin_scope_identities_from_released_ranges,
]);
export const run_delete_orphan_plugin_scope_grants = app_migrations.runner(
	internal.migrations.delete_orphan_plugin_scope_grants,
);
export const run_delete_stranded_plugin_data_scopes = app_migrations.runner(
	internal.migrations.delete_stranded_plugin_data_scopes,
);
export const run_audit_projection_private_folder_authority = app_migrations.runner(
	internal.migrations.audit_projection_private_folder_authority,
);
export const run_audit_projection_root_authority = app_migrations.runner(
	internal.migrations.audit_projection_root_authority,
);
export const run_audit_projection_file_authority = app_migrations.runner(
	internal.migrations.audit_projection_file_authority,
);
// Prove private ACL cleanup remains reachable before changing any projection pointer.
const projection_scaling_cutover_migrations = [
	internal.migrations.audit_projection_private_folder_authority,
	internal.migrations.audit_projection_root_authority,
	internal.migrations.audit_projection_file_authority,
	internal.migrations.backfill_projection_file_content_pairs,
	internal.migrations.reset_chitchat_projection_state_cursors,
];
export const run_projection_scaling_cutover = app_migrations.runner(projection_scaling_cutover_migrations);

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { expect, test } = import.meta.vitest;

	test("audits private folders before changing projection pointers", () => {
		expect(projection_scaling_cutover_migrations.map(getFunctionName)).toEqual([
			"migrations:audit_projection_private_folder_authority",
			"migrations:audit_projection_root_authority",
			"migrations:audit_projection_file_authority",
			"migrations:backfill_projection_file_content_pairs",
			"migrations:reset_chitchat_projection_state_cursors",
		]);
	});

	test("preserves append activity and sequence before adding empty defaults", () => {
		expect(plugin_scope_append_activity_migrations.map(getFunctionName)).toEqual([
			"migrations:backfill_plugin_scope_last_append_from_documents",
			"migrations:default_plugin_scope_last_append",
		]);
	});
}
