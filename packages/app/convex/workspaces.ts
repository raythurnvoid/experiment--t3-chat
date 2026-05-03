import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel";
import type { access_control_Permission, access_control_Role } from "../shared/access-control.ts";
import { server_convex_get_user_fallback_to_anonymous, should_never_happen } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { quotas_db_ensure, quotas_db_get } from "./quotas.ts";
import {
	workspaces_DEFAULT_PROJECT_NAME,
	workspaces_DEFAULT_WORKSPACE_NAME,
	workspaces_description_normalize,
	workspaces_list_sort_projects_for_workspace,
	workspaces_list_sort_workspaces,
	workspaces_name_autofix_and_validate,
} from "../shared/workspaces.ts";
import app_convex_schema from "./schema.ts";
import {
	access_control_db_ensure_role_assignment,
	access_control_db_ensure_role_permission_grant,
	access_control_db_has_permission,
} from "./access_control.ts";
import { data_deletion_db_request } from "../server/data_deletion.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";

const access_control_workspace_role_permission_grants = [
	{ role: "admin", permission: "workspace.update" },
	{ role: "admin", permission: "workspace.members.manage" },
	{ role: "admin", permission: "project.create" },
	{ role: "admin", permission: "project.update" },
	{ role: "admin", permission: "project.delete" },
	{ role: "admin", permission: "project.members.manage" },
	{ role: "admin", permission: "asset.read" },
	{ role: "admin", permission: "asset.write" },
	{ role: "admin", permission: "workspace.roles.manage" },
	{ role: "admin", permission: "asset.permissions.manage" },
	{ role: "member", permission: "workspace.update" },
	{ role: "member", permission: "project.create" },
	{ role: "member", permission: "project.update" },
	{ role: "member", permission: "project.delete" },
	{ role: "member", permission: "asset.read" },
	{ role: "member", permission: "asset.write" },
] as const satisfies Array<{ role: access_control_Role; permission: access_control_Permission }>;

const access_control_project_role_permission_grants = [
	{ role: "admin", permission: "project.update" },
	{ role: "admin", permission: "project.delete" },
	{ role: "admin", permission: "project.members.manage" },
	{ role: "admin", permission: "asset.read" },
	{ role: "admin", permission: "asset.write" },
	{ role: "admin", permission: "asset.permissions.manage" },
	{ role: "member", permission: "project.update" },
	{ role: "member", permission: "project.delete" },
	{ role: "member", permission: "asset.read" },
	{ role: "member", permission: "asset.write" },
] as const satisfies Array<{ role: access_control_Role; permission: access_control_Permission }>;

/**
 * Autofix then validate a workspace or project name.
 *
 * @returns A result containing the normalized name if valid, or an error message if invalid.
 */
function workspaces_validate_name(name: string) {
	return workspaces_name_autofix_and_validate(name);
}

function workspaces_validate_description(raw: string) {
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
	if (!membership || membership.userId !== args.userId || membership.active === false) {
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

	const isDefault = Boolean(args.default) && name === workspaces_DEFAULT_WORKSPACE_NAME;

	// Allow only default workspaces to reuse their global name; user-created workspaces stay globally unique.
	const existingWorkspace = isDefault
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
		// Non-default workspace ownership consumes the creator's workspace quota.
		const quota = await quotas_db_get(ctx, {
			quotaName: "extra_workspaces",
			userId: args.userId,
		});
		const remainingCount = Math.max(0, quota.maxCount - quota.usedCount);
		if (remainingCount <= 0) {
			return Result({
				_nay: {
					message: "Workspace quota reached",
				},
			});
		}

		await ctx.db.patch("quotas", quota._id, {
			usedCount: quota.usedCount + 1,
			updatedAt: args.now,
		});
	}

	const workspaceId = await ctx.db.insert("workspaces", {
		name,
		description: args.description,
		default: args.default ?? false,
		billingMode: "user",
		updatedAt: args.now,
	});

	const defaultProjectId = await ctx.db.insert("workspaces_projects", {
		workspaceId,
		name: workspaces_DEFAULT_PROJECT_NAME,
		description: "",
		default: true,
		updatedAt: args.now,
	});

	const updates = [
		ctx.db.patch("workspaces", workspaceId, {
			defaultProjectId,
		}),

		quotas_db_ensure(ctx, {
			quotaName: "extra_projects",
			workspaceId,
			now: args.now,
		}),

		ctx.db.insert("workspaces_projects_users", {
			workspaceId: workspaceId,
			projectId: defaultProjectId,
			userId: args.userId,
			active: true,
			updatedAt: args.now,
		}),

		access_control_db_ensure_role_assignment(ctx, {
			workspaceId,
			projectId: defaultProjectId,
			userId: args.userId,
			role: "owner",
			now: args.now,
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

	for (const grant of access_control_workspace_role_permission_grants) {
		await access_control_db_ensure_role_permission_grant(ctx, {
			workspaceId,
			projectId: defaultProjectId,
			resourceKind: "workspace",
			resourceId: String(workspaceId),
			role: grant.role,
			permission: grant.permission,
			now: args.now,
		});
	}

	for (const grant of access_control_project_role_permission_grants) {
		await access_control_db_ensure_role_permission_grant(ctx, {
			workspaceId,
			projectId: defaultProjectId,
			resourceKind: "project",
			resourceId: String(defaultProjectId),
			role: grant.role,
			permission: grant.permission,
			now: args.now,
		});
	}

	return Result({
		_yay: {
			workspaceId,
			defaultProjectId,
			name,
			defaultProjectName: workspaces_DEFAULT_PROJECT_NAME,
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

	const hasMembership = Boolean(
		await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_active_user_workspace_project", (q) =>
				q.eq("active", true).eq("userId", args.userId).eq("workspaceId", args.workspaceId),
			)
			.first(),
	);

	if (!hasMembership) {
		return Result({
			_nay: {
				message: "Workspace not found",
			},
		});
	}

	const [defaultProjects, nonDefaultProjects] = await Promise.all([
		ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspace_default", (q) => q.eq("workspaceId", args.workspaceId).eq("default", true))
			.collect(),
		ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspace_default", (q) => q.eq("workspaceId", args.workspaceId).eq("default", false))
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

	const quota = await quotas_db_get(ctx, {
		quotaName: "extra_projects",
		workspaceId: args.workspaceId,
	});
	const remainingCount = Math.max(0, quota.maxCount - quota.usedCount);
	if (remainingCount <= 0) {
		return Result({
			_nay: {
				message: "Project quota reached",
			},
		});
	}

	await ctx.db.patch("quotas", quota._id, {
		usedCount: quota.usedCount + 1,
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
		active: true,
		updatedAt: args.now,
	});

	await access_control_db_ensure_role_assignment(ctx, {
		workspaceId: args.workspaceId,
		projectId,
		userId: args.userId,
		role: "member",
		now: args.now,
	});

	for (const grant of access_control_project_role_permission_grants) {
		await access_control_db_ensure_role_permission_grant(ctx, {
			workspaceId: args.workspaceId,
			projectId,
			resourceKind: "project",
			resourceId: String(projectId),
			role: grant.role,
			permission: grant.permission,
			now: args.now,
		});
	}

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
			name: workspaces_DEFAULT_WORKSPACE_NAME,
			description: "",
			now: args.now,
			default: true,
		});
	}
}

export const list = query({
	args: {},
	returns: v.object({
		workspaces: v.array(
			v.object({
				...doc(app_convex_schema, "workspaces").fields,
				ownerUserId: v.id("users"),
			}),
		),
		workspaceIdsProjectsDict: v.record(v.id("workspaces"), v.array(doc(app_convex_schema, "workspaces_projects"))),
	}),
	handler: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const memberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_active_user_workspace_project", (q) => q.eq("active", true).eq("userId", userAuth.id))
			.collect();

		const projectIdsByWorkspace = new Map<Id<"workspaces">, Set<Id<"workspaces_projects">>>();
		for (const membership of memberships) {
			let projectIds = projectIdsByWorkspace.get(membership.workspaceId);
			if (!projectIds) {
				projectIds = new Set();
				projectIdsByWorkspace.set(membership.workspaceId, projectIds);
			}
			projectIds.add(membership.projectId);
		}

		const workspacesUnsorted = await Promise.try(async () => {
			const workspacesPromises = [];

			for (const workspaceId of projectIdsByWorkspace.keys()) {
				workspacesPromises.push(ctx.db.get("workspaces", workspaceId));
			}

			const workspaces = [];
			for (const workspacePromise of workspacesPromises) {
				const workspace = await workspacePromise;

				if (workspace) {
					workspaces.push(workspace);
				}
			}

			return workspaces;
		});

		// Presentation order: default workspace first, then locale-aware name (+ `_id` tiebreaker). Project rows per workspace: workspace primary first (`defaultProjectId` / `default` flag), then the same name rule.
		const workspaces = workspaces_list_sort_workspaces(
			await Promise.all(
				workspacesUnsorted.map(async (workspace) => {
					if (workspace.default) {
						return {
							...workspace,
							ownerUserId: userAuth.id,
						};
					}

					const defaultProjectId = workspace.defaultProjectId;
					if (!defaultProjectId) {
						throw should_never_happen("Workspace default project not found", { workspaceId: workspace._id });
					}

					const ownerAssignment = await ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_workspace_project_role_user", (q) =>
							q.eq("workspaceId", workspace._id).eq("projectId", defaultProjectId).eq("role", "owner"),
						)
						.first();
					if (!ownerAssignment) {
						throw should_never_happen("Workspace owner assignment not found", { workspaceId: workspace._id });
					}

					return {
						...workspace,
						ownerUserId: ownerAssignment.userId,
					};
				}),
			),
		);

		const workspaceIdsProjectsDict = Object.fromEntries(
			await Promise.all(
				workspaces.map(async (workspace) => {
					const workspaceId = workspace._id;
					const projectIds = projectIdsByWorkspace.get(workspaceId);

					if (!projectIds) {
						throw should_never_happen("Project ids not found for workspace", { workspaceId });
					}

					const projectsPromises = [];
					for (const projectId of projectIds) {
						projectsPromises.push(ctx.db.get("workspaces_projects", projectId));
					}

					const projects = [];
					for (const projectPromise of projectsPromises) {
						const project = await projectPromise;
						if (project !== null) {
							projects.push(project);
						}
					}

					const projectsSorted = workspaces_list_sort_projects_for_workspace(workspace, projects);

					return [workspaceId, projectsSorted] as const;
				}),
			),
		);

		return {
			workspaces,
			workspaceIdsProjectsDict,
		};
	},
});

export const get_membership_for_scope = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "workspaces_projects_users"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const workspaceId = ctx.db.normalizeId("workspaces", args.workspaceId);
		const projectId = ctx.db.normalizeId("workspaces_projects", args.projectId);
		if (!workspaceId || !projectId) {
			return null;
		}

		const membership = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_active_user_workspace_project", (q) =>
				q.eq("active", true).eq("userId", userAuth.id).eq("workspaceId", workspaceId).eq("projectId", projectId),
			)
			.first();

		return membership;
	},
});

export const get_membership_by_workspace_project_name = query({
	args: {
		workspaceName: v.string(),
		projectName: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "workspaces_projects_users"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((userAuth) => {
			if (!userAuth) {
				return null;
			}

			return ctx.db.get("users", userAuth.id);
		});

		if (!user) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const workspaceNameResult = workspaces_validate_name(args.workspaceName);
		if (workspaceNameResult._nay) {
			return null;
		}

		const projectNameResult = workspaces_validate_name(args.projectName);
		if (projectNameResult._nay) {
			return null;
		}

		const memberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_active_user_workspace_project", (q) => q.eq("active", true).eq("userId", user._id))
			.collect();

		const candidateMembershipsPromises = [];
		for (const membership of memberships) {
			candidateMembershipsPromises.push(
				Promise.all([
					ctx.db.get("workspaces", membership.workspaceId),
					ctx.db.get("workspaces_projects", membership.projectId),
				]).then(([workspace, project]) => {
					if (!workspace || !project) {
						return;
					}

					if (project.workspaceId !== membership.workspaceId) {
						return;
					}

					if (workspace.name !== workspaceNameResult._yay || project.name !== projectNameResult._yay) {
						return;
					}

					return membership;
				}),
			);
		}

		let foundMembership = null;
		for (const candidateMembershipsPromise of candidateMembershipsPromises) {
			const candidateMembership = await candidateMembershipsPromise;
			if (candidateMembership) {
				foundMembership = candidateMembership;
				break;
			}
		}

		if (!foundMembership) {
			return null;
		}

		return foundMembership;
	},
});

async function db_get_membership(
	ctx: QueryCtx,
	args: { membershipId: Id<"workspaces_projects_users">; userId: Id<"users"> },
) {
	const membership = await ctx.db.get("workspaces_projects_users", args.membershipId);
	if (!membership || membership.userId !== args.userId || membership.active === false) {
		return null;
	}
	return membership;
}

/**
 * Get the membership doc.
 *
 * Useful to check user access to resources.
 */
export const get_membership = query({
	args: {
		membershipId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "workspaces_projects_users"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		// Normalize untrusted request ids before `db.get`; Convex throws for malformed strings and wrong-table ids.
		const membershipId = ctx.db.normalizeId("workspaces_projects_users", args.membershipId.trim());
		if (!membershipId) {
			return null;
		}

		return await db_get_membership(ctx, { membershipId, userId: userAuth.id });
	},
});

export const list_workspace_project_users = query({
	args: {
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
	},
	returns: v.union(v.array(v.id("users")), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const [currentProjectMembership, projectMemberships] = await Promise.all([
			// Check if the current user is part of the requested project.
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId),
				)
				.first(),
			// Get all users in the requested project.
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_workspace_project_user", (q) =>
					q.eq("active", true).eq("workspaceId", args.workspaceId).eq("projectId", args.projectId),
				)
				.collect(),
		]);

		// Return nothing if the user requesting the list is not part of the project.
		if (!currentProjectMembership) {
			return null;
		}

		return projectMemberships.map((membership) => membership.userId);
	},
});

export const create_workspace = mutation({
	args: {
		name: v.string(),
		description: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			workspaceId: v.id("workspaces"),
			defaultProjectId: v.id("workspaces_projects"),
			name: v.string(),
			defaultProjectName: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const descriptionResult = workspaces_validate_description(args.description);
		if (descriptionResult._nay) {
			return Result({
				_nay: {
					message: descriptionResult._nay.message,
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "workspaces_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		return await workspaces_db_create(ctx, {
			userId: userAuth.id,
			name: args.name,
			description: descriptionResult._yay,
			now,
		});
	},
});

export const create_project = mutation({
	args: {
		workspaceId: v.id("workspaces"),
		name: v.string(),
		description: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			name: v.string(),
			projectId: v.id("workspaces_projects"),
			workspaceId: v.id("workspaces"),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const descriptionResult = workspaces_validate_description(args.description);
		if (descriptionResult._nay) {
			return Result({
				_nay: {
					message: descriptionResult._nay.message,
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "workspaces_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		return await workspaces_db_create_project(ctx, {
			userId: userAuth.id,
			workspaceId: args.workspaceId,
			name: args.name,
			description: descriptionResult._yay,
			now,
		});
	},
});

/**
 * Add an existing user to a workspace project by id or by email.
 * The default project means workspace membership, so adding to
 * another project also adds the user to default when needed.
 */
export const invite_user_to_workspace_project = mutation({
	args: {
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		email: v.optional(v.string()),
		userIdToAdd: v.optional(v.id("users")),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "workspaces_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		let userIdToAdd = args.userIdToAdd ?? null;
		if (!userIdToAdd) {
			const email = args.email?.trim().toLowerCase() ?? "";
			if (!email) {
				return Result({ _nay: { message: "Email is required" } });
			}

			const anagraphic = await ctx.db
				.query("users_anagraphics")
				.withIndex("by_email", (q) => q.eq("email", email))
				.unique()
				.catch(() => "duplicate_email" as const);
			if (!anagraphic || anagraphic === "duplicate_email") {
				return Result({ _nay: { message: "User to add not found" } });
			}
			userIdToAdd = anagraphic.userId;
		}

		if (userAuth.id === userIdToAdd) {
			return Result({ _nay: { message: "Cannot invite yourself" } });
		}

		const now = Date.now();

		// Load the user, workspace, and requested project before checking membership and permissions.
		const [userToAdd, workspace, project] = await Promise.all([
			ctx.db.get("users", userIdToAdd),
			ctx.db.get("workspaces", args.workspaceId),
			ctx.db.get("workspaces_projects", args.projectId),
		]);

		if (!userToAdd || userToAdd.deletedAt != null) {
			return Result({ _nay: { message: "User to add not found" } });
		}

		if (!workspace || !project || project.workspaceId !== args.workspaceId) {
			return Result({ _nay: { message: "Project not found" } });
		}

		if (!workspace.defaultProjectId) {
			throw should_never_happen("Workspace default project not found", {
				workspaceId: workspace._id,
			});
		}
		const defaultProjectId = workspace.defaultProjectId;
		const isDefaultProject = project._id === defaultProjectId;

		if (workspace.default) {
			return Result({ _nay: { message: "Cannot add user to default workspace" } });
		}

		const [currentHomeMembership, canManageMembers] = await Promise.all([
			// Check if the current user is part of the workspace before adding another user.
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("workspaceId", workspace._id)
						.eq("projectId", defaultProjectId),
				)
				.first(),
			access_control_db_has_permission(ctx, {
				workspaceId: workspace._id,
				projectId: defaultProjectId,
				defaultProjectId,
				resourceKind: "workspace",
				resourceId: String(workspace._id),
				permission: "workspace.members.manage",
				userId: userAuth.id,
			}),
		]);
		if (!currentHomeMembership) {
			return Result({ _nay: { message: "Project not found" } });
		}

		if (!canManageMembers) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Check if the user is already in the default project and in the requested project.
		const [existingHomeMembership, existingProjectMembership] = await Promise.all([
			isDefaultProject
				? null
				: ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_active_user_workspace_project", (q) =>
							q
								.eq("active", true)
								.eq("userId", userIdToAdd)
								.eq("workspaceId", workspace._id)
								.eq("projectId", defaultProjectId),
						)
						.first(),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q.eq("active", true).eq("userId", userIdToAdd).eq("workspaceId", workspace._id).eq("projectId", project._id),
				)
				.first(),
		]);

		if (existingProjectMembership) {
			// Treat repeated invite attempts as success when the user is already in the requested project.
			return Result({ _yay: null });
		}

		// Add the user to the default project and, when different, to the requested project.
		await Promise.all([
			existingHomeMembership
				? null
				: ctx.db.insert("workspaces_projects_users", {
						workspaceId: workspace._id,
						projectId: defaultProjectId,
						userId: userIdToAdd,
						active: true,
						updatedAt: now,
					}),
			access_control_db_ensure_role_assignment(ctx, {
				workspaceId: workspace._id,
				projectId: defaultProjectId,
				userId: userIdToAdd,
				role: "member",
				now,
			}),
			isDefaultProject
				? null
				: ctx.db.insert("workspaces_projects_users", {
						workspaceId: workspace._id,
						projectId: project._id,
						userId: userIdToAdd,
						active: true,
						updatedAt: now,
					}),
			isDefaultProject
				? null
				: access_control_db_ensure_role_assignment(ctx, {
						workspaceId: workspace._id,
						projectId: project._id,
						userId: userIdToAdd,
						role: "member",
						now,
					}),
			ctx.db.insert("notifications", {
				userId: userIdToAdd,
				kind: "workspace_project_invite",
				read: false,
				actorUserId: userAuth.id,
				workspaceId: workspace._id,
				projectId: project._id,
				updatedAt: now,
			}),
		]);

		return Result({ _yay: null });
	},
});

export const remove_user_from_workspace = mutation({
	args: {
		workspaceId: v.id("workspaces"),
		userIdToRemove: v.id("users"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const workspace = await ctx.db.get("workspaces", args.workspaceId);
		if (!workspace) {
			return Result({ _nay: { message: "Workspace not found" } });
		}

		if (!workspace.defaultProjectId) {
			throw should_never_happen("Workspace default project not found", {
				workspaceId: workspace._id,
			});
		}
		const defaultProjectId = workspace.defaultProjectId;

		const [currentHomeMembership, userToRemoveIsOwner, canManageMembers] = await Promise.all([
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("workspaceId", workspace._id)
						.eq("projectId", defaultProjectId),
				)
				.first(),
			// Check if the user is the owner of the workspace.
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_workspace_project_role_user", (q) =>
					q.eq("workspaceId", workspace._id).eq("projectId", defaultProjectId).eq("role", "owner"),
				)
				.first()
				.then((ownerAssignment) => ownerAssignment?.userId === args.userIdToRemove),
			access_control_db_has_permission(ctx, {
				workspaceId: workspace._id,
				projectId: defaultProjectId,
				defaultProjectId,
				resourceKind: "workspace",
				resourceId: String(workspace._id),
				permission: "workspace.members.manage",
				userId: userAuth.id,
			}),
		]);
		if (!currentHomeMembership) {
			return Result({ _nay: { message: "Workspace not found" } });
		}

		if (workspace.default) {
			return Result({ _nay: { message: "Cannot remove users from the default workspace" } });
		}

		if (userToRemoveIsOwner) {
			return Result({ _nay: { message: "Cannot remove the workspace owner" } });
		}

		// Allow regular members to leave, but keep removing another user behind member-management permission.
		if (userAuth.id !== args.userIdToRemove && !canManageMembers) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "workspaces_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		await Promise.all([
			// Remove invite notifications for the workspace access the user is losing.
			Promise.all([
				ctx.db
					.query("notifications")
					.withIndex("by_workspace_user_read", (q) =>
						q.eq("workspaceId", workspace._id).eq("userId", args.userIdToRemove).eq("read", false),
					)
					.collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_workspace_user_read", (q) =>
						q.eq("workspaceId", workspace._id).eq("userId", args.userIdToRemove).eq("read", true),
					)
					.collect(),
			]).then((notificationsByReadState) =>
				Promise.all(notificationsByReadState.flat().map((notification) => ctx.db.delete(notification._id))),
			),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q.eq("active", true).eq("userId", args.userIdToRemove).eq("workspaceId", workspace._id),
				)
				.collect()
				.then((memberships) =>
					Promise.all(memberships.map((membership) => ctx.db.delete("workspaces_projects_users", membership._id))),
				),
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_workspace_user_project_role", (q) =>
					q.eq("workspaceId", workspace._id).eq("userId", args.userIdToRemove),
				)
				.collect()
				.then((rows) => Promise.all(rows.map((row) => ctx.db.delete("access_control_role_assignments", row._id)))),
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_workspace_user_project_resource_permission", (q) =>
					q.eq("workspaceId", workspace._id).eq("userId", args.userIdToRemove),
				)
				.collect()
				.then((rows) => Promise.all(rows.map((row) => ctx.db.delete("access_control_permission_grants", row._id)))),
		]);

		return Result({ _yay: null });
	},
});

export const edit_workspace = mutation({
	args: {
		workspaceId: v.id("workspaces"),
		defaultProjectId: v.id("workspaces_projects"),
		name: v.string(),
		description: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			name: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const [workspace, defaultProject, workspaceUserLookup] = await Promise.all([
			ctx.db.get("workspaces", args.workspaceId),
			ctx.db.get("workspaces_projects", args.defaultProjectId),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.defaultProjectId),
				)
				.first(),
		]);

		if (
			!workspace ||
			defaultProject === null ||
			defaultProject.workspaceId !== args.workspaceId ||
			!(workspace.defaultProjectId === defaultProject._id || defaultProject.default) ||
			!workspaceUserLookup
		) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}

		if (
			!(await access_control_db_has_permission(ctx, {
				workspaceId: workspace._id,
				projectId: defaultProject._id,
				defaultProjectId: defaultProject._id,
				resourceKind: "workspace",
				resourceId: String(workspace._id),
				permission: "workspace.update",
				userId: userAuth.id,
			}))
		) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		if (workspace.default) {
			return Result({
				_nay: {
					message: "Cannot edit the default workspace",
				},
			});
		}

		const descriptionResult = workspaces_validate_description(args.description);
		if (descriptionResult._nay) {
			return Result({
				_nay: {
					message: descriptionResult._nay.message,
				},
			});
		}

		const nameResult = workspaces_validate_name(args.name);
		if (nameResult._nay) {
			return Result({
				_nay: {
					message: nameResult._nay.message,
				},
			});
		}
		const name = nameResult._yay;
		const description = descriptionResult._yay;

		const existingWorkspace = await ctx.db
			.query("workspaces")
			.withIndex("by_name", (q) => q.eq("name", name))
			.first();
		if (existingWorkspace && existingWorkspace._id !== args.workspaceId) {
			return Result({
				_nay: {
					message: "Workspace name already exists",
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "workspaces_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		await ctx.db.patch("workspaces", args.workspaceId, {
			name,
			description,
			updatedAt: now,
		});

		return Result({
			_yay: {
				name,
			},
		});
	},
});

export const set_workspace_billing_mode = mutation({
	args: {
		workspaceId: v.id("workspaces"),
		billingMode: doc(app_convex_schema, "workspaces").fields.billingMode,
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const workspace = await ctx.db.get("workspaces", args.workspaceId);
		if (!workspace) {
			return Result({ _nay: { message: "Workspace not found" } });
		}

		if (workspace.default) {
			return Result({ _nay: { message: "Cannot manage billing for the default workspace" } });
		}

		const defaultProjectId = workspace.defaultProjectId;
		if (!defaultProjectId) {
			throw should_never_happen("Workspace default project not found", {
				workspaceId: workspace._id,
			});
		}

		const ownerAssignment = await ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_workspace_project_user_role", (q) =>
				q
					.eq("workspaceId", workspace._id)
					.eq("projectId", defaultProjectId)
					.eq("userId", userAuth.id)
					.eq("role", "owner"),
			)
			.first();
		if (!ownerAssignment) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "workspaces_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		await ctx.db.patch("workspaces", workspace._id, {
			billingMode: args.billingMode,
			updatedAt: Date.now(),
		});

		return Result({ _yay: null });
	},
});

export const edit_project = mutation({
	args: {
		workspaceId: v.id("workspaces"),
		defaultProjectId: v.id("workspaces_projects"),
		projectId: v.id("workspaces_projects"),
		name: v.string(),
		description: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			name: v.string(),
			workspaceId: v.id("workspaces"),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const [workspace, project, defaultProject, defaultProjectMembership, projectMembership] = await Promise.all([
			ctx.db.get("workspaces", args.workspaceId),
			ctx.db.get("workspaces_projects", args.projectId),
			ctx.db.get("workspaces_projects", args.defaultProjectId),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.defaultProjectId),
				)
				.first(),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId),
				)
				.first(),
		]);

		if (
			!workspace ||
			!project ||
			!defaultProject ||
			project.workspaceId !== args.workspaceId ||
			defaultProject.workspaceId !== args.workspaceId ||
			!(workspace.defaultProjectId === defaultProject._id || defaultProject.default) ||
			!defaultProjectMembership ||
			!projectMembership
		) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}

		if (
			!(await access_control_db_has_permission(ctx, {
				workspaceId: workspace._id,
				projectId: project._id,
				defaultProjectId: defaultProject._id,
				resourceKind: "project",
				resourceId: String(project._id),
				permission: "project.update",
				userId: userAuth.id,
			})) &&
			!(await access_control_db_has_permission(ctx, {
				workspaceId: workspace._id,
				projectId: defaultProject._id,
				defaultProjectId: defaultProject._id,
				resourceKind: "workspace",
				resourceId: String(workspace._id),
				permission: "workspace.update",
				userId: userAuth.id,
			}))
		) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		if ((workspace.defaultProjectId !== undefined && project._id === workspace.defaultProjectId) || project.default) {
			return Result({
				_nay: {
					message: "Cannot edit the default project",
				},
			});
		}

		const descriptionResult = workspaces_validate_description(args.description);
		if (descriptionResult._nay) {
			return Result({
				_nay: {
					message: descriptionResult._nay.message,
				},
			});
		}

		const nameResult = workspaces_validate_name(args.name);
		if (nameResult._nay) {
			return Result({
				_nay: {
					message: nameResult._nay.message,
				},
			});
		}
		const name = nameResult._yay;
		const description = descriptionResult._yay;

		const [defaultProjects, nonDefaultProjects] = await Promise.all([
			ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspace_default", (q) => q.eq("workspaceId", project.workspaceId).eq("default", true))
				.collect(),
			ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspace_default", (q) => q.eq("workspaceId", project.workspaceId).eq("default", false))
				.collect(),
		]);

		for (const row of [...defaultProjects, ...nonDefaultProjects]) {
			if (row._id !== args.projectId && row.name === name) {
				return Result({
					_nay: {
						message: "Project name already exists",
					},
				});
			}
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "workspaces_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		await ctx.db.patch("workspaces_projects", args.projectId, {
			name,
			description,
			updatedAt: now,
		});

		return Result({
			_yay: {
				name,
				workspaceId: project.workspaceId,
			},
		});
	},
});

export const delete_workspace = mutation({
	args: {
		workspaceId: v.id("workspaces"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const workspace = await ctx.db.get("workspaces", args.workspaceId);
		if (!workspace) {
			return Result({
				_nay: {
					message: "Workspace not found",
				},
			});
		}

		if (!workspace.defaultProjectId) {
			throw should_never_happen("Workspace default project not found", {
				workspaceId: workspace._id,
			});
		}
		const defaultProjectId = workspace.defaultProjectId;

		const [workspaceUserLookup, ownerAssignment] = await Promise.all([
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("workspaceId", workspace._id)
						.eq("projectId", defaultProjectId),
				)
				.first(),
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_workspace_project_role_user", (q) =>
					q.eq("workspaceId", workspace._id).eq("projectId", defaultProjectId).eq("role", "owner"),
				)
				.first(),
		]);
		if (!workspaceUserLookup) {
			return Result({
				_nay: {
					message: "Workspace not found",
				},
			});
		}

		if (workspace.default) {
			return Result({
				_nay: {
					message: "Cannot delete the default workspace",
				},
			});
		}

		if (ownerAssignment?.userId !== userAuth.id) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "workspaces_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const [, , , , userIdsPerProject] = await Promise.all([
			// Queue one delayed workspace purge row while you remove project memberships in parallel.
			data_deletion_db_request(ctx, {
				userId: userAuth.id,
				workspaceId: workspace._id,
				scope: "workspace",
			}),
			// Remove every invite notification tied to the workspace being deleted.
			ctx.db
				.query("notifications")
				.withIndex("by_workspace_user_read", (q) => q.eq("workspaceId", workspace._id))
				.collect()
				.then((notifications) => Promise.all(notifications.map((notification) => ctx.db.delete(notification._id)))),
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_workspace_project_user_role", (q) => q.eq("workspaceId", workspace._id))
				.collect()
				.then((rows) => Promise.all(rows.map((row) => ctx.db.delete("access_control_role_assignments", row._id)))),
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_workspace_project_resource_user_permission", (q) => q.eq("workspaceId", workspace._id))
				.collect()
				.then((rows) => Promise.all(rows.map((row) => ctx.db.delete("access_control_permission_grants", row._id)))),
			ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspace_default", (q) => q.eq("workspaceId", workspace._id))
				.collect()
				.then((workspaceProjects) =>
					Promise.all(
						workspaceProjects.map(async (project) => {
							const projectUsers = await ctx.db
								.query("workspaces_projects_users")
								.withIndex("by_project_user_active", (q) => q.eq("projectId", project._id))
								.collect();

							await Promise.all(
								projectUsers.map((projectUser) => ctx.db.delete("workspaces_projects_users", projectUser._id)),
							);

							return projectUsers.map((projectUser) => projectUser.userId);
						}),
					),
				),
		]);

		const affectedUserIds = new Set<Id<"users">>(userIdsPerProject.flat());

		if (ownerAssignment) {
			const quota = await quotas_db_get(ctx, {
				quotaName: "extra_workspaces",
				userId: ownerAssignment.userId,
			});
			if (quota.usedCount > 0) {
				await ctx.db.patch("quotas", quota._id, {
					usedCount: quota.usedCount - 1,
					updatedAt: now,
				});
			}
		}

		for (const userId of affectedUserIds) {
			await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
				userId,
				now: Date.now(),
			});
		}

		return Result({
			_yay: null,
		});
	},
});

export const delete_project = mutation({
	args: {
		projectId: v.id("workspaces_projects"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const [[project, workspace, workspaceUserLookup], projectUserLookup] = await Promise.all([
			ctx.db.get("workspaces_projects", args.projectId).then(
				async (project) =>
					[
						project,
						...(await Promise.try(async () => {
							if (!project) return [null, null] as const;

							const workspace = await ctx.db.get("workspaces", project.workspaceId);
							const defaultProjectId = workspace?.defaultProjectId;

							return [
								workspace,

								defaultProjectId
									? await ctx.db
											.query("workspaces_projects_users")
											.withIndex("by_active_user_workspace_project", (q) =>
												q
													.eq("active", true)
													.eq("userId", userAuth.id)
													.eq("workspaceId", project.workspaceId)
													.eq("projectId", defaultProjectId),
											)
											.first()
									: null,
							] as const;
						})),
					] as const,
			),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_project_user_active", (q) => q.eq("projectId", args.projectId))
				.collect(),
		]);

		if (!project || !workspace || !workspaceUserLookup || !projectUserLookup) {
			return Result({
				_nay: {
					message: "Project not found",
				},
			});
		}

		if (project.default) {
			return Result({
				_nay: {
					message: "Cannot delete the default project",
				},
			});
		}

		if (
			!(await access_control_db_has_permission(ctx, {
				workspaceId: workspace._id,
				projectId: project._id,
				defaultProjectId: workspaceUserLookup.projectId,
				resourceKind: "project",
				resourceId: String(project._id),
				permission: "project.update",
				userId: userAuth.id,
			})) &&
			!(await access_control_db_has_permission(ctx, {
				workspaceId: workspace._id,
				projectId: workspaceUserLookup.projectId,
				defaultProjectId: workspaceUserLookup.projectId,
				resourceKind: "workspace",
				resourceId: String(workspace._id),
				permission: "workspace.update",
				userId: userAuth.id,
			}))
		) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "workspaces_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const affectedUserIds = new Set<Id<"users">>(projectUserLookup.map((projectUser) => projectUser.userId));

		await data_deletion_db_request(ctx, {
			userId: userAuth.id,
			workspaceId: workspace._id,
			projectId: project._id,
			scope: "project",
		});
		const quota = await quotas_db_get(ctx, {
			quotaName: "extra_projects",
			workspaceId: workspace._id,
		});
		if (quota.usedCount > 0) {
			await ctx.db.patch("quotas", quota._id, {
				usedCount: quota.usedCount - 1,
				updatedAt: now,
			});
		}
		await Promise.all([
			// Remove invite notifications that pointed at the project being deleted.
			ctx.db
				.query("notifications")
				.withIndex("by_workspace_project_user", (q) =>
					q.eq("workspaceId", workspace._id).eq("projectId", project._id),
				)
				.collect()
				.then((notifications) => Promise.all(notifications.map((notification) => ctx.db.delete(notification._id)))),
			Promise.all(projectUserLookup.map((projectUser) => ctx.db.delete("workspaces_projects_users", projectUser._id))),
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_workspace_project_user_role", (q) =>
					q.eq("workspaceId", workspace._id).eq("projectId", project._id),
				)
				.collect()
				.then((rows) => Promise.all(rows.map((row) => ctx.db.delete("access_control_role_assignments", row._id)))),
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_workspace_project_resource_user_permission", (q) =>
					q.eq("workspaceId", workspace._id).eq("projectId", project._id),
				)
				.collect()
				.then((rows) => Promise.all(rows.map((row) => ctx.db.delete("access_control_permission_grants", row._id)))),
		]);

		await ctx.db.delete("workspaces_projects", project._id);
		for (const userId of affectedUserIds) {
			await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
				userId,
				now: Date.now(),
			});
		}

		return Result({
			_yay: null,
		});
	},
});
