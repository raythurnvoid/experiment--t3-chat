import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { plugins_file_grants_db_validate_pair } from "../server/plugins-file-grants.ts";
import { activities_db_require_by_source_id, activities_is_active } from "./activities_db.ts";
import { Result } from "common/errors-as-values-utils.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

// Remove these one-time steps and their preview after the retained-history audit.
export const normalize_plugin_run_pairs = app_migrations.define({
	table: "plugins_event_runs",
	batchSize: 25,
	migrateOne: async (ctx, run) => {
		if (run.filePairId !== undefined) return;
		const activity = await activities_db_require_by_source_id(ctx, run._id);
		const stage = await ctx.db
			.query("public_api_file_write_stages")
			.withIndex("by_run", (q) => q.eq("runId", run._id))
			.first();
		if (activities_is_active(activity.status) || stage)
			throw new Error("Wait for the old plugin run and its text writes to finish.");
		await ctx.db.patch("plugins_event_runs", run._id, { filePairId: null });
	},
});

export const normalize_plugin_target_pairs = app_migrations.define({
	table: "plugin_service_storage_targets",
	batchSize: 25,
	migrateOne: async (ctx, target) => {
		if (target.filePairId !== undefined && target.serviceAccountId !== undefined) return;
		const asset = await ctx.db.get("files_r2_assets", target.assetId);
		const waiter = await ctx.db
			.query("files_move_waiters")
			.withIndex("by_worker", (q) => q.eq("worker.kind", "upload").eq("worker.id", target.assetId))
			.first();
		if (target.state === "pending" || (asset && asset.processingWorkId !== null) || waiter)
			throw new Error("Wait for the old plugin upload and its conversion to finish.");
		await ctx.db.patch("plugin_service_storage_targets", target._id, {
			filePairId: target.filePairId ?? null,
			serviceAccountId: target.serviceAccountId ?? null,
		});
	},
});

export const retire_plugin_grants_without_pairs = app_migrations.define({
	table: "plugin_service_grants",
	batchSize: 25,
	migrateOne: async (ctx, grant) => {
		if (grant.filePairId) return;
		const stage = await ctx.db
			.query("public_api_file_write_stages")
			.withIndex("by_grant", (q) => q.eq("grantId", grant._id))
			.first();
		if (stage) throw new Error("Wait for the old service grant's text writes to finish.");
		const now = Date.now();
		await ctx.db.patch("plugin_service_grants", grant._id, {
			filePairId: null,
			...(grant.revokedAt === undefined
				? { revokedAt: now, revokedReason: "Personal file access started", updatedAt: now }
				: {}),
		});
	},
});

export const remove_plugin_file_access_model = app_migrations.define({
	table: "plugins_workspace_installations",
	batchSize: 25,
	migrateOne: async (ctx, installation) => {
		if (installation.fileAccessModel === undefined) return;
		await ctx.db.patch("plugins_workspace_installations", installation._id, { fileAccessModel: undefined });
	},
});

export const run_finish_plugin_file_access = app_migrations.runner([
	internal.migrations.normalize_plugin_run_pairs,
	internal.migrations.normalize_plugin_target_pairs,
	internal.migrations.retire_plugin_grants_without_pairs,
	internal.migrations.remove_plugin_file_access_model,
]);

// The component's dry run prints full documents. Roll back here with counts only.
export const preview_plugin_file_history = internalMutation({
	args: {
		step: v.union(v.literal("runs"), v.literal("targets"), v.literal("grants"), v.literal("installations")),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const steps = {
			runs: internal.migrations.normalize_plugin_run_pairs,
			targets: internal.migrations.normalize_plugin_target_pairs,
			grants: internal.migrations.retire_plugin_grants_without_pairs,
			installations: internal.migrations.remove_plugin_file_access_model,
		};
		const result = await ctx.runMutation(steps[args.step], {
			oneBatchOnly: true,
			dryRun: false,
			cursor: args.cursor,
			batchSize: 25,
		});
		throw new Error(JSON.stringify({ preview: true, ...result }));
	},
});

/**
 * Recheck one audit and switch its installation in the same transaction.
 * Remove this rollout switch after the final audit.
 */
export const switch_plugin_file_access = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		expected: v.object({
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			pluginVersionId: v.id("plugins_versions"),
			serviceAccountId: v.id("access_control_service_accounts"),
			installationUpdatedAt: v.number(),
			bindingId: v.id("plugins_service_account_bindings"),
			pairId: v.id("plugins_file_pairs"),
			userId: v.id("users"),
			membershipId: v.id("organizations_workspaces_users"),
			membershipLifetime: v.number(),
			consents: v.array(
				v.object({
					consentId: v.id("plugins_file_consents"),
					consentRevision: v.number(),
					rootNodeId: doc(app_convex_schema, "plugins_file_consents").fields.rootNodeId,
					level: doc(app_convex_schema, "plugins_file_consents").fields.requestedLevel,
				}),
			),
		}),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (!installation) return Result({ _nay: { message: "Not found" } });
		if (installation.fileAccessModel === "personal") return Result({ _yay: null });
		const { expected } = args;
		if (
			installation.organizationId !== expected.organizationId ||
			installation.workspaceId !== expected.workspaceId ||
			installation.pluginVersionId !== expected.pluginVersionId ||
			installation.serviceAccountId !== expected.serviceAccountId ||
			installation.updatedAt !== expected.installationUpdatedAt ||
			installation.status !== "enabled"
		) {
			return Result({ _nay: { message: "Installation changed. Audit it again before switching." } });
		}
		const [account, version, binding, pair] = await Promise.all([
			ctx.db.get("access_control_service_accounts", expected.serviceAccountId),
			ctx.db.get("plugins_versions", expected.pluginVersionId),
			ctx.db.get("plugins_service_account_bindings", expected.bindingId),
			plugins_file_grants_db_validate_pair(ctx, {
				pairId: expected.pairId,
				installationId: installation._id,
				userId: expected.userId,
			}),
		]);
		if (
			!account ||
			account.revokedAt !== null ||
			account.organizationId !== installation.organizationId ||
			account.workspaceId !== installation.workspaceId ||
			!version ||
			version.name !== installation.pluginName ||
			!binding ||
			binding.organizationId !== installation.organizationId ||
			binding.workspaceId !== installation.workspaceId ||
			binding.pluginName !== installation.pluginName ||
			binding.publisherUserId !== version.createdBy ||
			binding.sourceRepositoryUrl !== version.sourceRepositoryUrl ||
			binding.serviceAccountId !== account._id
		) {
			return Result({ _nay: { message: "Trusted account changed. Audit it again before switching." } });
		}
		if (
			!pair ||
			pair.membershipId !== expected.membershipId ||
			pair.membershipLifetime !== expected.membershipLifetime
		) {
			return Result({ _nay: { message: "Personal membership changed. Audit it again before switching." } });
		}
		if (expected.consents.length === 0)
			return Result({ _nay: { message: "Choose file consent and audit it before switching." } });
		// Whole workspace needs area eligibility. A saved folder can be an ordinary folder.
		for (const choice of expected.consents) {
			const consent = await ctx.db.get("plugins_file_consents", choice.consentId);
			if (
				!consent ||
				consent.organizationId !== installation.organizationId ||
				consent.workspaceId !== installation.workspaceId ||
				consent.pairId !== pair._id ||
				consent.rootNodeId !== choice.rootNodeId ||
				!consent.open ||
				consent.requestedLevel !== choice.level ||
				consent.appliedLevel !== choice.level ||
				consent.state !== "applied" ||
				(choice.rootNodeId === null && !consent.areaEligible) ||
				consent.revision !== choice.consentRevision
			) {
				return Result({ _nay: { message: "File consent changed. Audit it again before switching." } });
			}
		}
		// A queued old run must keep its original writes until it ends.
		for (const status of ["queued", "running", "awaiting_input", "stopping"] as const) {
			const active = await ctx.db
				.query("activities")
				.withIndex("by_source_installation_status", (q) =>
					q.eq("source.installationId", installation._id).eq("status", status),
				)
				.first();
			if (active) {
				return Result({ _nay: { message: "Wait for this plugin's current runs to finish, then try again." } });
			}
		}
		const stage = await ctx.db
			.query("public_api_file_write_stages")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", installation.organizationId).eq("workspaceId", installation.workspaceId),
			)
			.first();
		if (stage) {
			return Result({ _nay: { message: "Wait for this workspace's text writes to finish, then try again." } });
		}
		const target = await ctx.db
			.query("plugin_service_storage_targets")
			.withIndex("by_organization_workspace_installation_state", (q) =>
				q
					.eq("organizationId", installation.organizationId)
					.eq("workspaceId", installation.workspaceId)
					.eq("installationId", installation._id)
					.eq("state", "pending"),
			)
			.first();
		if (target) {
			return Result({ _nay: { message: "Wait for this plugin's uploads to finish, then try again." } });
		}
		await ctx.db.patch("plugins_workspace_installations", installation._id, { fileAccessModel: "personal" });
		return Result({ _yay: null });
	},
});
