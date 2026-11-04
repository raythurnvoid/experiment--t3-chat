import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { access_control_db_set_service_account_grant } from "./access_control.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { files_nodes_db_set_restricted_scope } from "./files_sharing_db.ts";
import { files_subtree_ops_db_start_rebuild, files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops_rebuild.ts";
import { files_nodes_db_resolve_parent_restricted_scope } from "./files_write_policy_db.ts";
import app_convex_schema from "./schema.ts";
import { convex_error } from "../server/convex-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

// TODO(migration): one-time. Plugin folders became regular folders, so the plugin reader data goes.
// Run `run_erase_plugin_file_access` after the phase A push, audit, then push phase B, which deletes
// this region, its test and the old schema fields.

/**
 * A plugin restricted this folder and chose its readers. Make it a regular folder: delete every grant
 * on it, then give it its parent's access, like an unrestrict of a folder with nobody added. The
 * files stay.
 *
 * A folder in the Trash only loses its grants. An unrestrict refuses Trash items, so it stays
 * restricted, and only the organization owner opens it after a restore.
 */
async function db_open_plugin_folder(
	ctx: MutationCtx,
	binding: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
	},
) {
	const node = await ctx.db.get("files_nodes", binding.nodeId);
	if (!node) return;
	// A plugin folder lives in a real workspace, so a person created it.
	if (node.createdBy === "SYSTEM") {
		throw should_never_happen("plugin folder created by the system", { nodeId: node._id });
	}

	// One node's grants are bounded by the share cap (`MAX_FILE_SHARE_GRANT_DOCS` in files_sharing.ts).
	const grants = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_user_permission", (q) =>
			q
				.eq("organizationId", binding.organizationId)
				.eq("workspaceId", binding.workspaceId)
				.eq("resourceKind", "file")
				.eq("resourceId", String(node._id)),
		)
		.collect();
	for (const grant of grants) {
		// Account grants go through the account writer, like every account grant change.
		if (grant.principalKind === "service_account" && grant.serviceAccountId) {
			const removed = await access_control_db_set_service_account_grant(ctx, {
				organizationId: binding.organizationId,
				workspaceId: binding.workspaceId,
				serviceAccountId: grant.serviceAccountId,
				resource: { kind: "file", nodeId: node._id },
				level: null,
			});
			if (removed._nay) throw convex_error(removed._nay);
			continue;
		}
		await ctx.db.delete("access_control_permission_grants", grant._id);
	}

	if (node.restrictedScopeNodeId === node._id && node.archiveOperationId === null) {
		await files_nodes_db_set_restricted_scope({
			ctx,
			organizationId: binding.organizationId,
			workspaceId: binding.workspaceId,
			nodeId: node._id,
			restrictedScopeNodeId: await files_nodes_db_resolve_parent_restricted_scope(ctx, { parentId: node.parentId }),
		});
		await files_subtree_ops_db_start_rebuild(ctx, {
			kind: "scope",
			organizationId: binding.organizationId,
			workspaceId: binding.workspaceId,
			userId: node.createdBy,
			membership: null,
			roots: [{ node, oldTreePath: node.treePath }],
			budget: { nodes: files_subtree_ops_STEP_MAX_NODES, hasPaginated: false },
			now: Date.now(),
		});
	}
	await files_media_validation_db_advance_version(ctx, binding);
}

// One folder can have more than 100 grants to delete, so both binding steps keep their batches small.
export const erase_plugins_file_access_bindings = app_migrations.define({
	table: "plugins_file_access_bindings",
	batchSize: 10,
	migrateOne: async (ctx, binding) => {
		await db_open_plugin_folder(ctx, binding);
		await ctx.db.delete("plugins_file_access_bindings", binding._id);
	},
});

export const erase_plugins_external_file_bindings = app_migrations.define({
	table: "plugins_external_file_bindings",
	batchSize: 10,
	migrateOne: async (ctx, binding) => {
		// A detached binding means a person changed this folder's sharing. People own its grants since
		// then, so keep them and only delete the plugin's record.
		if (binding.detachedAt === null) {
			await db_open_plugin_folder(ctx, binding);
		}
		await ctx.db.delete("plugins_external_file_bindings", binding._id);
	},
});

export const erase_plugins_external_file_reader_changes = app_migrations.define({
	table: "plugins_external_file_reader_changes",
	migrateOne: async (ctx, change) => {
		await ctx.db.delete("plugins_external_file_reader_changes", change._id);
	},
});

/**
 * Delete the receipts of reader changes, and drop the reader revision from the others.
 */
export const erase_plugins_external_file_receipts_readers = app_migrations.define({
	table: "plugins_external_file_receipts",
	migrateOne: async (ctx, receipt) => {
		if (
			receipt.operation === "readers" ||
			receipt.operation === "rollback_readers" ||
			receipt.operation === "cancel_readers"
		) {
			await ctx.db.delete("plugins_external_file_receipts", receipt._id);
			return;
		}
		if (receipt.readerRevision === undefined) return;

		const { _id, _creationTime, readerRevision: _readerRevision, ...next } = receipt;
		await ctx.db.replace("plugins_external_file_receipts", _id, next);
	},
});

/**
 * A plugin reader grant is tagged with the member's membership lifetime. Delete every one: the
 * plugin chose those readers, and only normal sharing decides access now. Most of them sat on the
 * folders that the binding steps above opened.
 *
 * Run this before `erase_files_share_rows_externalPluginMembershipLifetime`. The flush deletes or
 * rewrites the grant's share rows, but a rewrite keeps the old tag on the row.
 */
export const erase_access_control_permission_grants_externalPluginMembershipLifetime = app_migrations.define({
	table: "access_control_permission_grants",
	migrateOne: async (ctx, grant) => {
		if (grant.externalPluginMembershipLifetime === undefined) return;

		await ctx.db.delete("access_control_permission_grants", grant._id);
		// Saved media checks may have used this grant.
		await files_media_validation_db_advance_version(ctx, grant);
	},
});

export const erase_files_share_rows_externalPluginMembershipLifetime = app_migrations.define({
	table: "files_share_rows",
	migrateOne: async (ctx, row) => {
		if (row.externalPluginMembershipLifetime === undefined) return;

		const { _id, _creationTime, externalPluginMembershipLifetime: _lifetime, ...next } = row;
		await ctx.db.replace("files_share_rows", _id, next);
	},
});

export const erase_plugins_workspace_installations_sandbox = app_migrations.define({
	table: "plugins_workspace_installations",
	migrateOne: async (ctx, installation) => {
		if (installation.sandbox === undefined) return;

		const { _id, _creationTime, sandbox: _sandbox, ...next } = installation;
		await ctx.db.replace("plugins_workspace_installations", _id, next);
	},
});

export const erase_public_api_file_write_stages_expectedReaderRevision = app_migrations.define({
	table: "public_api_file_write_stages",
	migrateOne: async (ctx, stage) => {
		if (stage.externalFileWrite?.expectedReaderRevision === undefined) return;

		const { expectedReaderRevision: _expectedReaderRevision, ...externalFileWrite } = stage.externalFileWrite;
		await ctx.db.patch("public_api_file_write_stages", stage._id, { externalFileWrite });
	},
});

// The own-access capability granted reader lists, which are gone. Remove it from every stored
// capability list, so phase B can drop the literal from the schema.
const without_own_access = <T extends string>(capabilities: T[]) =>
	capabilities.filter((capability) => capability !== "workspace.files.own-access");

export const erase_plugins_versions_own_access = app_migrations.define({
	table: "plugins_versions",
	migrateOne: async (ctx, version) => {
		if (!version.capabilities.includes("workspace.files.own-access")) return;
		await ctx.db.patch("plugins_versions", version._id, { capabilities: without_own_access(version.capabilities) });
	},
});

export const erase_plugins_workspace_installations_own_access = app_migrations.define({
	table: "plugins_workspace_installations",
	migrateOne: async (ctx, installation) => {
		if (!installation.acceptedCapabilities.includes("workspace.files.own-access")) return;
		await ctx.db.patch("plugins_workspace_installations", installation._id, {
			acceptedCapabilities: without_own_access(installation.acceptedCapabilities),
		});
	},
});

export const erase_plugins_event_runs_own_access = app_migrations.define({
	table: "plugins_event_runs",
	migrateOne: async (ctx, run) => {
		if (!run.acceptedCapabilities.includes("workspace.files.own-access")) return;
		await ctx.db.patch("plugins_event_runs", run._id, {
			acceptedCapabilities: without_own_access(run.acceptedCapabilities),
		});
	},
});

export const erase_organizations_integration_policies_own_access = app_migrations.define({
	table: "organizations_integration_policies",
	migrateOne: async (ctx, policy) => {
		if (!policy.plugins.allowlist.some((entry) => entry.capabilities.includes("workspace.files.own-access"))) return;
		await ctx.db.patch("organizations_integration_policies", policy._id, {
			plugins: {
				...policy.plugins,
				allowlist: policy.plugins.allowlist.map((entry) => ({
					...entry,
					capabilities: without_own_access(entry.capabilities),
				})),
			},
		});
	},
});

/**
 * Run from the repository root: `vp env exec pnpm --dir packages/app exec convex run "migrations:run_erase_plugin_file_access"`.
 * Runs the steps in this order, one after another.
 */
export const run_erase_plugin_file_access = app_migrations.runner([
	internal.migrations.erase_plugins_file_access_bindings,
	internal.migrations.erase_plugins_external_file_bindings,
	internal.migrations.erase_plugins_external_file_reader_changes,
	internal.migrations.erase_plugins_external_file_receipts_readers,
	internal.migrations.erase_access_control_permission_grants_externalPluginMembershipLifetime,
	internal.migrations.erase_files_share_rows_externalPluginMembershipLifetime,
	internal.migrations.erase_plugins_workspace_installations_sandbox,
	internal.migrations.erase_public_api_file_write_stages_expectedReaderRevision,
	internal.migrations.erase_plugins_versions_own_access,
	internal.migrations.erase_plugins_workspace_installations_own_access,
	internal.migrations.erase_plugins_event_runs_own_access,
	internal.migrations.erase_organizations_integration_policies_own_access,
]);
