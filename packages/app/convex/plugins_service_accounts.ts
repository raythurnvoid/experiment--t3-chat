import { v, type Infer } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import type { plugins_sandbox_root_validator } from "./schema.ts";
import type { access_control_Subject } from "./access_control.ts";
import {
	access_control_FILE_SHARE_PERMISSIONS,
	access_control_file_share_level_from_permissions,
	type access_control_FileShareLevel,
} from "../shared/access-control.ts";

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
const SANDBOX_ROOTS_MAX = 20;

/** A rebuild step runs right away, so a lease this old means the chain stopped. */
const SANDBOX_REBUILD_LEASE_MS = 10 * 60 * 1000;

/** Grants read per rebuild step. Each one costs two reads (binding, node). */
const SANDBOX_REBUILD_PAGE_SIZE = 100;

/** A plugin acts as its human, inside the installation's sandbox roots. */
export function plugins_sandbox_subject(
	installation: Doc<"plugins_workspace_installations">,
	userId: Id<"users">,
): access_control_Subject {
	return {
		kind: "user",
		userId,
		plugin: {
			installationId: installation._id,
			// A running rebuild has not read all grants yet, so the plugin reaches no folder until it ends.
			roots: installation.sandbox.rebuild === null ? installation.sandbox.roots : [],
		},
	};
}

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
 * The level of an account's grant on one resource, read from its permission docs like the share
 * dialog does, or null when it adds up to no level. At most three docs.
 */
export async function plugins_db_account_grant_level(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		serviceAccountId: Id<"access_control_service_accounts">;
		resource: { kind: "workspace" } | { kind: "file"; nodeId: Id<"files_nodes"> };
	},
) {
	const grants = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_serviceAccount_permission", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("resourceKind", args.resource.kind)
				.eq("resourceId", args.resource.kind === "workspace" ? args.workspaceId : args.resource.nodeId)
				.eq("principalKind", "service_account")
				.eq("serviceAccountId", args.serviceAccountId),
		)
		.take(access_control_FILE_SHARE_PERMISSIONS.length);
	return access_control_file_share_level_from_permissions(new Set(grants.map((grant) => grant.permission)));
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
	const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
	const old = installation?.sandbox.rebuild;
	// A new token must differ from the old one even within the same millisecond.
	const leaseUntil = Math.max(
		Date.now() + SANDBOX_REBUILD_LEASE_MS,
		old?.status === "running" ? old.leaseUntil + 1 : 0,
	);
	await ctx.db.patch("plugins_workspace_installations", args.installationId, {
		sandbox: { roots: [], rebuild: { status: "running", leaseUntil } },
	});
	await ctx.scheduler.runAfter(0, internal.plugins_service_accounts.sandbox_rebuild_step, {
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
		if (installation.sandbox.rebuild?.status === "too_many_folders") {
			// Only a removed grant can bring the account back under the cap.
			if (args.level === null) rebuilds.push(installation._id);
			continue;
		}

		const old = installation.sandbox.roots.find((root) => plugins_sandbox_root_key(root.target) === key);
		if (old?.level === (target ? args.level : undefined)) continue;
		const roots = installation.sandbox.roots.filter((root) => plugins_sandbox_root_key(root.target) !== key);
		if (target && args.level) {
			roots.push({ target, level: args.level });
		}
		if (roots.length > SANDBOX_ROOTS_MAX) {
			return Result({ _nay: { message: "A plugin can use at most 20 folders. Remove one on the plugin page first." } });
		}
		patches.push({ installationId: installation._id, roots });
	}

	for (const patch of patches) {
		const installation = installations.find((item) => item._id === patch.installationId)!;
		await ctx.db.patch("plugins_workspace_installations", patch.installationId, {
			sandbox: { roots: patch.roots, rebuild: installation.sandbox.rebuild },
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
async function db_sandbox_rebuild_page(
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
		if (grant.resourceKind !== "workspace" && grant.resourceKind !== "file") continue;
		// One grant doc per permission, so the same resource can show up to three times.
		const resource =
			grant.resourceKind === "workspace"
				? ({ kind: "workspace" } as const)
				: ({ kind: "file", nodeId: grant.resourceId as Id<"files_nodes"> } as const);
		const target = await plugins_db_sandbox_root_target(ctx, { ...installation, resource });
		const level = target
			? await plugins_db_account_grant_level(ctx, {
					...installation,
					serviceAccountId: installation.serviceAccountId,
					resource,
				})
			: null;
		if (!target || !level) continue;

		const index = roots.findIndex((root) => plugins_sandbox_root_key(root.target) === plugins_sandbox_root_key(target));
		if (index === -1) {
			roots.push({ target, level });
		} else {
			roots[index] = { target, level };
		}
		if (roots.length > SANDBOX_ROOTS_MAX) {
			return { roots: null, isDone: true, continueCursor: page.continueCursor };
		}
	}
	return { roots, isDone: page.isDone, continueCursor: page.continueCursor };
}

/**
 * One page of a sandbox rebuild (`plugins_db_schedule_sandbox_rebuild`).
 */
export const sandbox_rebuild_step = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		leaseUntil: v.number(),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		const rebuild = installation?.sandbox.rebuild;
		// A newer rebuild or the end of this one stops this chain.
		if (!installation || rebuild?.status !== "running" || rebuild.leaseUntil !== args.leaseUntil) {
			return null;
		}

		const page = await db_sandbox_rebuild_page(ctx, {
			installation,
			roots: installation.sandbox.roots,
			cursor: args.cursor,
		});
		if (!page.roots) {
			console.warn("A plugin sandbox rebuild found more than 20 folders", { installationId: installation._id });
			await ctx.db.patch("plugins_workspace_installations", installation._id, {
				sandbox: { roots: [], rebuild: { status: "too_many_folders" } },
			});
			return null;
		}
		if (page.isDone) {
			await ctx.db.patch("plugins_workspace_installations", installation._id, {
				sandbox: { roots: page.roots, rebuild: null },
			});
			return null;
		}

		const leaseUntil = Date.now() + SANDBOX_REBUILD_LEASE_MS;
		await ctx.db.patch("plugins_workspace_installations", installation._id, {
			sandbox: { roots: page.roots, rebuild: { status: "running", leaseUntil } },
		});
		await ctx.scheduler.runAfter(0, internal.plugins_service_accounts.sandbox_rebuild_step, {
			installationId: installation._id,
			leaseUntil,
			cursor: page.continueCursor,
		});
		return null;
	},
});

// The rebuild runs its own next steps. The cron only restarts a chain whose lease expired.
export const recover_sandbox_rebuilds = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const stuck = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_sandboxRebuildLeaseUntil", (q) =>
				// Installations with no running rebuild have no lease and sort before 0.
				q.gte("sandbox.rebuild.leaseUntil", 0).lte("sandbox.rebuild.leaseUntil", Date.now()),
			)
			.take(20);
		for (const installation of stuck) {
			await plugins_db_schedule_sandbox_rebuild(ctx, { installationId: installation._id });
		}
		return null;
	},
});

// #endregion Sandbox roots
