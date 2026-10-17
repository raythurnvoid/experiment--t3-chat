import type { Infer } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { plugins_sandbox_root_validator } from "./schema.ts";
import type { access_control_FileShareLevel, access_control_GrantPermission } from "../shared/access-control.ts";

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

// #region Sandbox roots

export type plugins_SandboxRoot = Infer<typeof plugins_sandbox_root_validator>;

/** Same cap as the grants a plugin can get at install. */
export const plugins_SANDBOX_ROOTS_MAX = 20;

/** A rebuild step runs right away, so a lease this old means the chain stopped. */
export const plugins_SANDBOX_REBUILD_LEASE_MS = 10 * 60 * 1000;

/** Grants read per rebuild step. Each one costs two reads (binding, node). */
const SANDBOX_REBUILD_PAGE_SIZE = 100;

export const plugins_SANDBOX_LEVEL_BY_PERMISSION: Partial<
	Record<access_control_GrantPermission, access_control_FileShareLevel>
> = {
	"content.read": "read",
	"content.write": "write",
	"content.permissions.manage": "manage",
};

export const plugins_SANDBOX_LEVEL_RANK: Record<access_control_FileShareLevel, number> = {
	read: 0,
	write: 1,
	manage: 2,
};

export function plugins_sandbox_root_key(target: plugins_SandboxRoot["target"]) {
	return target.kind === "open" ? "open" : target.nodeId;
}

/**
 * The root target one account grant gives, or null when it gives none: a plugin output folder (a
 * live `plugins_external_file_bindings` row of any installation) belongs to its plugin, which
 * reaches it without a slot, and a purged node gives nothing.
 *
 * This depends only on the binding and the node existing, and both changes call the sync. A later
 * Restrict above the node does not change the root: what the root gives is decided when it is read.
 */
export async function plugins_db_sandbox_root_target(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		resource: { kind: "workspace" } | { kind: "file"; nodeId: Id<"files_nodes"> };
	},
): Promise<plugins_SandboxRoot["target"] | null> {
	if (args.resource.kind === "workspace") {
		return { kind: "open" };
	}

	const nodeId = args.resource.nodeId;
	const binding = await ctx.db
		.query("plugins_external_file_bindings")
		.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
		.first();
	if (binding?.detachedAt === null) {
		return null;
	}

	const node = await ctx.db.get("files_nodes", nodeId);
	if (!node || node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId) {
		return null;
	}

	return { kind: "folder", nodeId };
}

/**
 * Start building the installation's roots from all its account's grants, in a background job.
 *
 * An account can hold one grant per plugin output folder, so "all grants" has no bound inside one
 * mutation. Until the job ends the plugin reaches no folder. The lease is also the job's token: a
 * newer start or an expired lease stops an old chain.
 */
export async function plugins_db_schedule_sandbox_rebuild(
	ctx: MutationCtx,
	args: { installationId: Id<"plugins_workspace_installations"> },
) {
	const leaseUntil = Date.now() + plugins_SANDBOX_REBUILD_LEASE_MS;
	await ctx.db.patch("plugins_workspace_installations", args.installationId, {
		sandbox: { roots: [], rebuild: { status: "running", leaseUntil } },
	});
	await ctx.scheduler.runAfter(0, internal.plugins.sandbox_rebuild_step, {
		installationId: args.installationId,
		leaseUntil,
		cursor: null,
	});
}

/**
 * Keep the sandbox roots of every installation of this account equal to the account's grant on one
 * resource. `level: null` means the grant is gone. Call it before any write: a 21st root answers
 * `_nay` and changes nothing.
 */
export async function plugins_db_sync_sandbox_root(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		serviceAccountId: Id<"access_control_service_accounts">;
		resource: { kind: "workspace" } | { kind: "file"; nodeId: Id<"files_nodes"> };
		level: access_control_FileShareLevel | null;
	},
) {
	// A service account belongs to one workspace, and a workspace has one installation per plugin.
	const installations = await ctx.db
		.query("plugins_workspace_installations")
		.withIndex("by_serviceAccount", (q) => q.eq("serviceAccountId", args.serviceAccountId))
		.collect();
	if (installations.length === 0) {
		return Result({ _yay: null });
	}

	const target = args.level === null ? null : await plugins_db_sandbox_root_target(ctx, args);
	const key = args.resource.kind === "workspace" ? "open" : args.resource.nodeId;
	const patches: Array<{ installationId: Id<"plugins_workspace_installations">; roots: plugins_SandboxRoot[] }> = [];
	const rebuilds: Array<Id<"plugins_workspace_installations">> = [];
	for (const installation of installations) {
		// The backfill builds roots for older installations.
		if (!installation.sandbox) continue;
		if (installation.sandbox.rebuild?.status === "too_many_folders") {
			rebuilds.push(installation._id);
			continue;
		}

		const roots = installation.sandbox.roots.filter((root) => plugins_sandbox_root_key(root.target) !== key);
		if (target && args.level) {
			roots.push({ target, level: args.level });
		}
		if (roots.length > plugins_SANDBOX_ROOTS_MAX) {
			return Result({ _nay: { message: "A plugin can use at most 20 folders. Remove one on the plugin page first." } });
		}
		patches.push({ installationId: installation._id, roots });
	}

	for (const patch of patches) {
		const installation = installations.find((item) => item._id === patch.installationId)!;
		await ctx.db.patch("plugins_workspace_installations", patch.installationId, {
			sandbox: { roots: patch.roots, rebuild: installation.sandbox!.rebuild },
		});
	}
	// A grant change may bring the account back under the cap.
	for (const installationId of rebuilds) {
		await plugins_db_schedule_sandbox_rebuild(ctx, { installationId });
	}
	return Result({ _yay: null });
}

/**
 * Read one page of the account's grants into the roots. A grant write during the job sets that one
 * root to the current grant, and each page reads the current grants, so the two agree at the end.
 * Answers `roots: null` past 20 roots.
 */
export async function plugins_db_sandbox_rebuild_page(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		roots: plugins_SandboxRoot[];
		cursor: string | null;
	},
) {
	const { installation } = args;
	const page = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_org_workspace_serviceAccount_permission_resource", (q) =>
			q
				.eq("organizationId", installation.organizationId)
				.eq("workspaceId", installation.workspaceId)
				.eq("serviceAccountId", installation.serviceAccountId)
				.eq("principalKind", "service_account"),
		)
		.paginate({ cursor: args.cursor, numItems: SANDBOX_REBUILD_PAGE_SIZE });

	const roots = [...args.roots];
	for (const grant of page.page) {
		// One grant doc per permission, so a resource's level is the highest permission seen.
		const level = plugins_SANDBOX_LEVEL_BY_PERMISSION[grant.permission];
		if (!level || (grant.resourceKind !== "workspace" && grant.resourceKind !== "file")) continue;
		const target = await plugins_db_sandbox_root_target(ctx, {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			resource:
				grant.resourceKind === "workspace"
					? { kind: "workspace" }
					: { kind: "file", nodeId: grant.resourceId as Id<"files_nodes"> },
		});
		if (!target) continue;

		const index = roots.findIndex((root) => plugins_sandbox_root_key(root.target) === plugins_sandbox_root_key(target));
		if (index === -1) {
			roots.push({ target, level });
		} else if (plugins_SANDBOX_LEVEL_RANK[level] > plugins_SANDBOX_LEVEL_RANK[roots[index].level]) {
			roots[index] = { target, level };
		}
		if (roots.length > plugins_SANDBOX_ROOTS_MAX) {
			return { roots: null, isDone: true, continueCursor: page.continueCursor };
		}
	}
	return { roots, isDone: page.isDone, continueCursor: page.continueCursor };
}

// #endregion Sandbox roots
