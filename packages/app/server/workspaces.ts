import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import { Result } from "../shared/errors-as-values-utils.ts";

const DEFAULT_WORKSPACE_NAME = "personal";
const DEFAULT_PROJECT_NAME = "home";

const workspace_project_name_regex = /^[a-z]+(?:-[a-z]+)*$/;

/**
 * Validate a workspace or project name.
 *
 * @returns A result containing the trimmed name if valid, or an error message if invalid.
 */
export function workspaces_validate_name(name: string) {
	const trimmedName = name.trim();

	if (trimmedName === "") {
		return Result({
			_nay: {
				name: "nay",
				message: "Name cannot be empty",
			},
		});
	}

	if (!workspace_project_name_regex.test(trimmedName)) {
		return Result({
			_nay: {
				name: "nay",
				message: "Invalid name",
			},
		});
	}

	return Result({
		_yay: trimmedName,
	});
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
	args: { userId: Id<"users">; name: string; now: number; default?: boolean },
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

	const workspaceId = await ctx.db.insert("workspaces", {
		name,
		default: args.default ?? false,
		updatedAt: args.now,
	});

	const defaultProjectId = await ctx.db.insert("workspaces_projects", {
		workspaceId,
		name: DEFAULT_PROJECT_NAME,
		default: true,
		updatedAt: args.now,
	});

	const updates = [
		ctx.db.patch("workspaces", workspaceId, {
			defaultProjectId,
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
		},
	});
}

export async function workspaces_db_ensure_default_workspace_and_project_for_user(
	ctx: MutationCtx,
	args: { userId: Id<"users">; now: number },
) {
	const workspace = await ctx.db.get("users", args.userId).then((user) => {
		if (user?.defaultWorkspaceId) {
			return ctx.db.get("workspaces", user.defaultWorkspaceId);
		}
	});

	if (!workspace) {
		await workspaces_db_create(ctx, {
			userId: args.userId,
			name: DEFAULT_WORKSPACE_NAME,
			now: args.now,
			default: true,
		});
	}
}
