import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import app_convex_schema from "./schema.ts";

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

export const erase_plugins_file_access_bindings = app_migrations.define({
	table: "plugins_file_access_bindings",
	migrateOne: async (ctx, binding) => {
		await ctx.db.delete("plugins_file_access_bindings", binding._id);
	},
});

export const erase_plugins_external_file_bindings = app_migrations.define({
	table: "plugins_external_file_bindings",
	migrateOne: async (ctx, binding) => {
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
 * A plugin reader grant is tagged with the member's membership lifetime. The old check ignored a
 * grant of an old lifetime, so the member left and came back since. Delete those grants. A grant of
 * the live lifetime gave access, so keep it as a normal grant and only drop the tag.
 *
 * Run this before `erase_files_share_rows_externalPluginMembershipLifetime`. The flush deletes or
 * rewrites the grant's share rows, but a rewrite keeps the old tag on the row.
 */
export const erase_access_control_permission_grants_externalPluginMembershipLifetime = app_migrations.define({
	table: "access_control_permission_grants",
	migrateOne: async (ctx, grant) => {
		if (grant.externalPluginMembershipLifetime === undefined) return;

		const membership = grant.userId
			? await organizations_membership_lifetimes_db_get(ctx, { workspaceId: grant.workspaceId, userId: grant.userId })
			: null;
		if (membership?.active && membership.lifetime === grant.externalPluginMembershipLifetime) {
			await ctx.db.patch("access_control_permission_grants", grant._id, {
				externalPluginMembershipLifetime: undefined,
			});
			return;
		}

		await ctx.db.delete("access_control_permission_grants", grant._id);
		// Saved media checks may have used this grant. The old check ignored it, but advance anyway, like
		// every grant delete does.
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
]);
