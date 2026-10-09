import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

// Nodes saved before the local write-policy model have no stored value. Reads treated that as `null`.
export const backfill_files_nodes_new_child_write_policy = app_migrations.define({
	table: "files_nodes",
	migrateOne: async (ctx, node) => {
		if (node.newChildWritePolicy !== undefined) return;
		await ctx.db.patch("files_nodes", node._id, { newChildWritePolicy: null });
	},
});

// Memberships saved before the removal marker have no stored value. Reads treated that as `false`.
export const backfill_organizations_workspaces_users_pending_organization_removal = app_migrations.define({
	table: "organizations_workspaces_users",
	migrateOne: async (ctx, membership) => {
		if (membership.pendingOrganizationRemoval !== undefined) return;
		await ctx.db.patch("organizations_workspaces_users", membership._id, { pendingOrganizationRemoval: false });
	},
});

// A document charged before per-member counters has `chargedTo` but no counter id, so no counter ever
// held it. Clearing `chargedTo` keeps that accounting and makes the two fields always set together.
// A missing `machineBytes` was read as 0; store the value a write stores today.
export const backfill_plugins_data_charge = app_migrations.define({
	table: "plugins_data",
	migrateOne: async (ctx, document) => {
		const clearCharge = document.chargedTo !== undefined && document.chargedToMemberUsageId === undefined;
		if (!clearCharge && document.machineBytes !== undefined) return;
		const charged = document.chargedTo !== undefined && !clearCharge;
		await ctx.db.patch("plugins_data", document._id, {
			...(clearCharge ? { chargedTo: undefined } : {}),
			...(document.machineBytes === undefined ? { machineBytes: charged ? 0 : document.byteSize } : {}),
		});
	},
});

// Every row carries the same `generation` literal, so the field says nothing.
export const remove_plugins_data_member_usage_generation = app_migrations.define({
	table: "plugins_data_member_usage",
	migrateOne: async (ctx, usage) => {
		if (usage.generation === undefined) return;
		const { _id, _creationTime, generation: _generation, ...next } = usage;
		await ctx.db.replace("plugins_data_member_usage", _id, next);
	},
});

/** Run migrations from the CLI: `pnpx convex run migrations:run_<migration_name>` (cwd: packages/app). */
export const run = app_migrations.runner();
export const run_backfill_files_nodes_new_child_write_policy = app_migrations.runner(
	internal.migrations.backfill_files_nodes_new_child_write_policy,
);
export const run_backfill_organizations_workspaces_users_pending_organization_removal = app_migrations.runner(
	internal.migrations.backfill_organizations_workspaces_users_pending_organization_removal,
);
export const run_backfill_plugins_data_charge = app_migrations.runner(internal.migrations.backfill_plugins_data_charge);
export const run_remove_plugins_data_member_usage_generation = app_migrations.runner(
	internal.migrations.remove_plugins_data_member_usage_generation,
);
