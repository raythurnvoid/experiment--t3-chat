import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { components } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { plugins_file_grants_db_validate_pair } from "../server/plugins-file-grants.ts";
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
