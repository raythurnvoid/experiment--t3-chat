import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import { Result } from "../shared/errors-as-values-utils.ts";
import { user_limits, workspace_limits } from "../shared/limits.ts";
import { workspaces_description_normalize, workspaces_name_autofix_and_validate } from "../shared/workspaces.ts";
import { should_never_happen } from "./server-utils.ts";

const DEFAULT_WORKSPACE_NAME = "personal";
const DEFAULT_PROJECT_NAME = "home";

/**
 * Autofix then validate a workspace or project name.
 *
 * @returns A result containing the normalized name if valid, or an error message if invalid.
 */
export function workspaces_validate_name(name: string) {
	return workspaces_name_autofix_and_validate(name);
}

export function workspaces_validate_description(raw: string) {
	return workspaces_description_normalize(raw);
}

/**
 * Get a membership doc by id and verify it belongs to the given user.
 */
export async function workspaces_db_get_membership_for_user(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; membershipId: Id<"workspaces_projects_users"> },
) {
	const membership = await ctx.db.get("workspaces_projects_users", args.membershipId);
	if (!membership || membership.userId !== args.userId) {
		return null;
	}
	return membership;
}

export async function workspaces_db_create(
	ctx: MutationCtx,
	args: { userId: Id<"users">; name: string; description: string; now: number; default?: boolean },
) {
	const nameResult = workspaces_validate_name(args.name);
	if (nameResult._nay) {
		return Result({
			_nay: {
				message: nameResult._nay.message,
			},
		});
	}
	const name = nameResult._yay;

	const allowDuplicateDefaultWorkspaceName = Boolean(args.default) && name === DEFAULT_WORKSPACE_NAME;

	const existingWorkspace = allowDuplicateDefaultWorkspaceName
		? null
		: await ctx.db
				.query("workspaces")
				.withIndex("by_name", (q) => q.eq("name", name))
				.first();
	if (existingWorkspace) {
		return Result({
			_nay: {
				message: "Workspace name already exists",
			},
		});
	}

	if (!args.default) {
		const definition = user_limits.EXTRA_WORKSPACES;
		const limit = await ctx.db
			.query("limits_per_user")
			.withIndex("by_userId_limitName", (q) => q.eq("userId", args.userId).eq("limitName", definition.name))
			.first();
		if (!limit) {
			throw should_never_happen("[workspaces_db_create] Missing user limit doc", {
				userId: args.userId,
				limitName: definition.name,
			});
		}

		const remainingCount = Math.max(0, limit.maxCount - limit.usedCount);
		if (remainingCount <= 0) {
			return Result({
				_nay: {
					message: definition.disabledReason,
				},
			});
		}

		await ctx.db.patch("limits_per_user", limit._id, {
			usedCount: limit.usedCount + 1,
			updatedAt: args.now,
		});
	}

	const workspaceId = await ctx.db.insert("workspaces", {
		name,
		description: args.description,
		default: args.default ?? false,
		ownerUserId: args.userId,
		updatedAt: args.now,
	});

	const defaultProjectId = await ctx.db.insert("workspaces_projects", {
		workspaceId,
		name: DEFAULT_PROJECT_NAME,
		description: "",
		default: true,
		updatedAt: args.now,
	});

	const updates = [
		ctx.db.patch("workspaces", workspaceId, {
			defaultProjectId,
		}),

		ctx.db.insert("limits_per_workspace", {
			workspaceId,
			limitName: workspace_limits.EXTRA_PROJECTS.name,
			usedCount: 0,
			maxCount: workspace_limits.EXTRA_PROJECTS.maxCount,
			createdAt: args.now,
			updatedAt: args.now,
		}),

		ctx.db.insert("workspaces_projects_users", {
			workspaceId: workspaceId,
			projectId: defaultProjectId,
			userId: args.userId,
		}),
	];

	if (args.default) {
		updates.push(
			ctx.db.patch("users", args.userId, {
				defaultWorkspaceId: workspaceId,
				defaultProjectId,
			}),
		);
	}

	await Promise.all(updates);

	return Result({
		_yay: {
			workspaceId,
			defaultProjectId,
			name,
			defaultProjectName: DEFAULT_PROJECT_NAME,
		},
	});
}

export async function workspaces_db_create_project(
	ctx: MutationCtx,
	args: { userId: Id<"users">; workspaceId: Id<"workspaces">; name: string; description: string; now: number },
) {
	const nameResult = workspaces_validate_name(args.name);
	if (nameResult._nay) {
		return Result({
			_nay: {
				message: nameResult._nay.message,
			},
		});
	}
	const name = nameResult._yay;

	const workspace = await ctx.db.get("workspaces", args.workspaceId);
	if (!workspace) {
		return Result({
			_nay: {
				message: "Workspace not found",
			},
		});
	}

	const memberships = await ctx.db
		.query("workspaces_projects_users")
		.withIndex("by_userId_workspaceId_projectId", (q) =>
			q.eq("userId", args.userId).eq("workspaceId", args.workspaceId),
		)
		.collect();

	if (memberships.length === 0) {
		return Result({
			_nay: {
				message: "Workspace not found",
			},
		});
	}

	const [defaultProjects, nonDefaultProjects] = await Promise.all([
		ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspaceId_default", (q) => q.eq("workspaceId", args.workspaceId).eq("default", true))
			.collect(),
		ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspaceId_default", (q) => q.eq("workspaceId", args.workspaceId).eq("default", false))
			.collect(),
	]);

	for (const project of [...defaultProjects, ...nonDefaultProjects]) {
		if (project.name === name) {
			return Result({
				_nay: {
					message: "Project name already exists",
				},
			});
		}
	}

	const limit = await ctx.db
		.query("limits_per_workspace")
		.withIndex("by_workspaceId_limitName", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("limitName", workspace_limits.EXTRA_PROJECTS.name),
		)
		.first();
	if (!limit) {
		throw should_never_happen("[workspaces_db_create_project] Missing workspace limit doc", {
			workspaceId: args.workspaceId,
			limitName: workspace_limits.EXTRA_PROJECTS.name,
		});
	}
	const remainingCount = Math.max(0, limit.maxCount - limit.usedCount);
	if (remainingCount <= 0) {
		return Result({
			_nay: {
				message: workspace_limits.EXTRA_PROJECTS.disabledReason,
			},
		});
	}

	await ctx.db.patch("limits_per_workspace", limit._id, {
		usedCount: limit.usedCount + 1,
		updatedAt: args.now,
	});

	const projectId = await ctx.db.insert("workspaces_projects", {
		workspaceId: args.workspaceId,
		name,
		description: args.description,
		default: false,
		updatedAt: args.now,
	});

	await ctx.db.insert("workspaces_projects_users", {
		workspaceId: args.workspaceId,
		projectId,
		userId: args.userId,
	});

	return Result({
		_yay: {
			projectId,
			name,
			workspaceId: args.workspaceId,
		},
	});
}

export async function workspaces_db_ensure_default_workspace_and_project_for_user(
	ctx: MutationCtx,
	args: { userId: Id<"users">; now: number },
) {
	const user = await ctx.db.get("users", args.userId);
	if (!user) {
		return;
	}

	const defaultWorkspace = user.defaultWorkspaceId ? await ctx.db.get("workspaces", user.defaultWorkspaceId) : null;

	if (!defaultWorkspace) {
		await workspaces_db_create(ctx, {
			userId: args.userId,
			name: DEFAULT_WORKSPACE_NAME,
			description: "",
			now: args.now,
			default: true,
		});
	}
}
