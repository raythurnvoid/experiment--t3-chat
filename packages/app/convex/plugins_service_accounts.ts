import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { access_control_Subject } from "./access_control.ts";

/**
 * A saved pin must still match the installation's current trusted binding.
 */
export async function plugins_db_get_live_service_account(
	ctx: QueryCtx | MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		serviceAccountId: Id<"access_control_service_accounts">;
	},
) {
	const { installation, serviceAccountId } = args;
	if (installation.serviceAccountId !== serviceAccountId) {
		return null;
	}

	const account = await ctx.db.get("access_control_service_accounts", serviceAccountId);
	if (
		!account ||
		account.revokedAt !== null ||
		account.organizationId !== installation.organizationId ||
		account.workspaceId !== installation.workspaceId
	) {
		return null;
	}

	const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
	if (!version || version.name !== installation.pluginName) {
		return null;
	}

	const binding = await ctx.db
		.query("plugins_service_account_bindings")
		.withIndex("by_organization_workspace_pluginName_publisher_source", (q) =>
			q
				.eq("organizationId", installation.organizationId)
				.eq("workspaceId", installation.workspaceId)
				.eq("pluginName", version.name)
				.eq("publisherUserId", version.createdBy)
				.eq("sourceRepositoryUrl", version.sourceRepositoryUrl),
		)
		.first();

	return binding?.serviceAccountId === serviceAccountId ? account : null;
}

/**
 * A plugin acts as its human, and it is also limited by the normal grants of the installation's
 * service account. Callers check first that this account is the installation's live account
 * (`plugins_db_get_live_service_account`).
 */
export function plugins_sandbox_subject(
	installation: Doc<"plugins_workspace_installations">,
	userId: Id<"users">,
): access_control_Subject {
	return {
		kind: "user",
		userId,
		plugin: { installationId: installation._id, serviceAccountId: installation.serviceAccountId },
	};
}
