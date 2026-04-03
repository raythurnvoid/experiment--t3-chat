import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel";
import { server_convex_get_user_fallback_to_anonymous, should_never_happen } from "../server/server-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { user_limits, workspace_limits } from "../shared/limits.ts";
import {
	user_DATA_DELETION_RETENTION_MS,
	type user_DataDeletionRequestScope,
} from "../server/users.ts";
import {
	workspaces_list_sort_projects_for_workspace,
	workspaces_list_sort_workspaces,
} from "../shared/workspaces.ts";
import app_convex_schema from "./schema.ts";
import {
	workspaces_db_create,
	workspaces_db_create_project,
	workspaces_db_ensure_default_workspace_and_project_for_user,
	workspaces_validate_description,
	workspaces_validate_name,
} from "../server/workspaces.ts";

/**
 * TODO: to be implemented
 */
async function user_is_workspace_admin(
	_ctx: MutationCtx,
	_args: { workspaceId: Id<"workspaces">; userId: Id<"users"> },
) {
	return true;
}

/**
 * TODO: to be implemented
 */
async function user_is_project_admin(
	_ctx: MutationCtx,
	_args: { projectId: Id<"workspaces_projects">; userId: Id<"users"> },
) {
	return true;
}

const WORKSPACE_DATA_DELETION_PURGE_BATCH_SIZE = 50;

async function workspaces_queue_data_deletion_request(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		scope: user_DataDeletionRequestScope;
	},
) {
	const existing = await ctx.db
		.query("workspaces_data_deletion_requests")
		.withIndex("by_workspaceId_projectId", (q) => q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId))
		.first();

	if (existing) {
		return;
	}

	await ctx.db.insert("workspaces_data_deletion_requests", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		scope: args.scope,
	});
}

export const list = query({
	args: {},
	returns: v.object({
		workspaces: v.array(doc(app_convex_schema, "workspaces")),
		workspaceIdsProjectsDict: v.record(v.id("workspaces"), v.array(doc(app_convex_schema, "workspaces_projects"))),
	}),
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const memberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_userId_workspaceId_projectId", (q) => q.eq("userId", user.id))
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
		const workspaces = workspaces_list_sort_workspaces(workspacesUnsorted);

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
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const workspaceId = ctx.db.normalizeId("workspaces", args.workspaceId);
		const projectId = ctx.db.normalizeId("workspaces_projects", args.projectId);
		if (!workspaceId || !projectId) {
			return null;
		}

		const membership = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_userId_workspaceId_projectId", (q) =>
				q.eq("userId", user.id).eq("workspaceId", workspaceId).eq("projectId", projectId),
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
		const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((user) => ctx.db.get("users", user.id));
		if (!user) {
			return null;
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
			.withIndex("by_userId_workspaceId_projectId", (q) => q.eq("userId", user._id))
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
	if (!membership || membership.userId !== args.userId) {
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
		membershipId: v.id("workspaces_projects_users"),
	},
	returns: v.union(doc(app_convex_schema, "workspaces_projects_users"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		return await db_get_membership(ctx, { membershipId: args.membershipId, userId: user.id });
	},
});

export const get_membership_from_string = query({
	args: {
		membershipId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "workspaces_projects_users"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const membershipId = ctx.db.normalizeId("workspaces_projects_users", args.membershipId.trim());
		if (!membershipId) {
			return null;
		}

		return await db_get_membership(ctx, { membershipId, userId: user.id });
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
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const now = Date.now();

		const descriptionResult = workspaces_validate_description(args.description);
		if (descriptionResult._nay) {
			return Result({
				_nay: {
					message: descriptionResult._nay.message,
				},
			});
		}

		return await workspaces_db_create(ctx, {
			userId: user.id,
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
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const now = Date.now();

		const descriptionResult = workspaces_validate_description(args.description);
		if (descriptionResult._nay) {
			return Result({
				_nay: {
					message: descriptionResult._nay.message,
				},
			});
		}

		return await workspaces_db_create_project(ctx, {
			userId: user.id,
			workspaceId: args.workspaceId,
			name: args.name,
			description: descriptionResult._yay,
			now,
		});
	},
});

export const add_user_to_workspace_project = mutation({
	args: {
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		userIdToAdd: v.id("users"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const [userToAdd, workspace, project, projectCurrentUserLookup, projectUserToAddLookup] = await Promise.all([
			ctx.db.get("users", args.userIdToAdd),
			ctx.db.get("workspaces", args.workspaceId),
			ctx.db.get("workspaces_projects", args.projectId),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", args.projectId).eq("userId", user.id))
				.first(),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", args.projectId).eq("userId", args.userIdToAdd))
				.first(),
		]);

		if (!userToAdd) {
			return Result({
				_nay: {
					message: "User to add not found",
				},
			});
		}

		if (!workspace || !project || !projectCurrentUserLookup || project.workspaceId !== args.workspaceId) {
			return Result({
				_nay: {
					message: "Project not found",
				},
			});
		}

		if (workspace.default) {
			return Result({
				_nay: {
					message: "Cannot add user to default workspace",
				},
			});
		}

		if (projectUserToAddLookup) {
			return Result({
				_nay: {
					message: "User already a member of the project",
				},
			});
		}

		const invitedUser = await ctx.db.get("users", args.userIdToAdd);
		if (!invitedUser) {
			return Result({
				_nay: {
					message: "User not found",
				},
			});
		}

		if (!(await user_is_workspace_admin(ctx, { workspaceId: workspace._id, userId: user.id }))) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		await ctx.db.insert("workspaces_projects_users", {
			workspaceId: workspace._id,
			projectId: project._id,
			userId: args.userIdToAdd,
		});

		return Result({
			_yay: null,
		});
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
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const now = Date.now();

		const [workspace, defaultProject, workspaceUserLookup] = await Promise.all([
			ctx.db.get("workspaces", args.workspaceId),
			ctx.db.get("workspaces_projects", args.defaultProjectId),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", args.defaultProjectId).eq("userId", user.id))
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

		if (!(await user_is_workspace_admin(ctx, { workspaceId: workspace._id, userId: user.id }))) {
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
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const now = Date.now();

		const [workspace, project, defaultProject, defaultProjectMembership, projectMembership] = await Promise.all([
			ctx.db.get("workspaces", args.workspaceId),
			ctx.db.get("workspaces_projects", args.projectId),
			ctx.db.get("workspaces_projects", args.defaultProjectId),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", args.defaultProjectId).eq("userId", user.id))
				.first(),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", args.projectId).eq("userId", user.id))
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
			!(await user_is_project_admin(ctx, { projectId: project._id, userId: user.id })) &&
			!(await user_is_workspace_admin(ctx, { workspaceId: workspace._id, userId: user.id }))
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
				.withIndex("by_workspaceId_default", (q) => q.eq("workspaceId", project.workspaceId).eq("default", true))
				.collect(),
			ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspaceId_default", (q) => q.eq("workspaceId", project.workspaceId).eq("default", false))
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

/**
 * Process queued workspace/project content deletions whose retention window has passed.
 */
export const purge_data_deletion_requests = internalMutation({
	args: {
		/**
		 * Convex tests only: simulated wall time (ms). Omit in production and cron (`Date.now()` is used).
		 * Pass a value past the retention window (e.g. `_creationTime + user_DATA_DELETION_RETENTION_MS + 1`)
		 * so purge eligibility runs in one step without waiting.
		 */
		_test_now: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const purgeEligibleCutoff = now - user_DATA_DELETION_RETENTION_MS;
		const requests = await ctx.db
			.query("workspaces_data_deletion_requests")
			.withIndex("by_creation_time", (q) => q.lte("_creationTime", purgeEligibleCutoff))
			.order("asc")
			.take(WORKSPACE_DATA_DELETION_PURGE_BATCH_SIZE);

		for (const request of requests) {
			const [
				aiChatThreads,
				aiChatThreadsMessages,
				pagesPendingEdits,
				pagesPendingEditsLastSequenceSaved,
				pagesRows,
				pagesMarkdownContent,
				pagesMarkdownChunks,
				pagesPlainTextChunks,
				pagesYjsSnapshots,
				pagesYjsUpdates,
				pagesYjsDocsLastSequences,
				pagesSnapshots,
				pagesSnapshotsContents,
				chatMessages,
			] = await Promise.all([
				ctx.db
					.query("ai_chat_threads")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspaceId === request.workspaceId && row.projectId === request.projectId),
					),
				ctx.db
					.query("ai_chat_threads_messages_aisdk_5")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspaceId === request.workspaceId && row.projectId === request.projectId),
					),
				ctx.db
					.query("pages_pending_edits")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspaceId === request.workspaceId && row.projectId === request.projectId),
					),
				ctx.db
					.query("pages_pending_edits_last_sequence_saved")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspaceId === request.workspaceId && row.projectId === request.projectId),
					),
				ctx.db
					.query("pages")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspaceId === request.workspaceId && row.projectId === request.projectId),
					),
				ctx.db
					.query("pages_markdown_content")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspace_id === request.workspaceId && row.project_id === request.projectId),
					),
				ctx.db
					.query("pages_markdown_chunks")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspaceId === request.workspaceId && row.projectId === request.projectId),
					),
				ctx.db
					.query("pages_plain_text_chunks")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspaceId === request.workspaceId && row.projectId === request.projectId),
					),
				ctx.db
					.query("pages_yjs_snapshots")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspace_id === request.workspaceId && row.project_id === request.projectId),
					),
				ctx.db
					.query("pages_yjs_updates")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspace_id === request.workspaceId && row.project_id === request.projectId),
					),
				ctx.db
					.query("pages_yjs_docs_last_sequences")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspace_id === request.workspaceId && row.project_id === request.projectId),
					),
				ctx.db
					.query("pages_snapshots")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspace_id === request.workspaceId && row.project_id === request.projectId),
					),
				ctx.db
					.query("pages_snapshots_contents")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspace_id === request.workspaceId && row.project_id === request.projectId),
					),
				ctx.db
					.query("chat_messages")
					.collect()
					.then((rows) =>
						rows.filter((row) => row.workspaceId === request.workspaceId && row.projectId === request.projectId),
					),
			]);

			const pendingEditIds = new Set(pagesPendingEdits.map((row) => row._id));
			const pageIds = new Set(pagesRows.map((row) => row._id));

			const [pagesPendingEditsCleanupTasks, pagesYjsSnapshotSchedules] = await Promise.all([
				ctx.db
					.query("pages_pending_edits_cleanup_tasks")
					.collect()
					.then((rows) => rows.filter((row) => pendingEditIds.has(row.pendingEditId))),
				ctx.db
					.query("pages_yjs_snapshot_schedules")
					.collect()
					.then((rows) => rows.filter((row) => pageIds.has(row.page_id))),
			]);

			await Promise.all(
				pagesPendingEditsCleanupTasks.map((row) => ctx.db.delete("pages_pending_edits_cleanup_tasks", row._id)),
			);
			await Promise.all(pagesYjsSnapshotSchedules.map((row) => ctx.db.delete("pages_yjs_snapshot_schedules", row._id)));
			await Promise.all(aiChatThreadsMessages.map((row) => ctx.db.delete("ai_chat_threads_messages_aisdk_5", row._id)));
			await Promise.all(aiChatThreads.map((row) => ctx.db.delete("ai_chat_threads", row._id)));
			await Promise.all(chatMessages.map((row) => ctx.db.delete("chat_messages", row._id)));
			await Promise.all(
				pagesPendingEditsLastSequenceSaved.map((row) =>
					ctx.db.delete("pages_pending_edits_last_sequence_saved", row._id),
				),
			);
			await Promise.all(pagesPendingEdits.map((row) => ctx.db.delete("pages_pending_edits", row._id)));
			await Promise.all(pagesPlainTextChunks.map((row) => ctx.db.delete("pages_plain_text_chunks", row._id)));
			await Promise.all(pagesMarkdownChunks.map((row) => ctx.db.delete("pages_markdown_chunks", row._id)));
			await Promise.all(pagesYjsSnapshots.map((row) => ctx.db.delete("pages_yjs_snapshots", row._id)));
			await Promise.all(pagesYjsUpdates.map((row) => ctx.db.delete("pages_yjs_updates", row._id)));
			await Promise.all(
				pagesYjsDocsLastSequences.map((row) => ctx.db.delete("pages_yjs_docs_last_sequences", row._id)),
			);
			await Promise.all(pagesSnapshotsContents.map((row) => ctx.db.delete("pages_snapshots_contents", row._id)));
			await Promise.all(pagesSnapshots.map((row) => ctx.db.delete("pages_snapshots", row._id)));
			await Promise.all(pagesMarkdownContent.map((row) => ctx.db.delete("pages_markdown_content", row._id)));
			await Promise.all(pagesRows.map((row) => ctx.db.delete("pages", row._id)));

			await ctx.db.delete("workspaces_data_deletion_requests", request._id);
		}
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
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const now = Date.now();

		const [workspace, worspaceUserLookup] = await Promise.all([
			ctx.db.get("workspaces", args.workspaceId),
			ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspaceId_default", (q) => q.eq("workspaceId", args.workspaceId))
				.first()
				.then(async (project) =>
					project
						? await ctx.db
								.query("workspaces_projects_users")
								.withIndex("by_projectId_userId", (q) => q.eq("projectId", project._id).eq("userId", user.id))
								.first()
						: null,
				),
		]);

		if (!workspace || !worspaceUserLookup) {
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

		if (!(await user_is_workspace_admin(ctx, { workspaceId: workspace._id, userId: user.id }))) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		const workspace_projects = await ctx.db
			.query("workspaces_projects")
			.withIndex("by_workspaceId_default", (q) => q.eq("workspaceId", workspace._id))
			.collect();
		const affected_user_ids = new Set<Id<"users">>(
			(
				await Promise.all(
					workspace_projects.map(async (project) => {
						const projectUsers = await ctx.db
							.query("workspaces_projects_users")
							.withIndex("by_projectId_userId", (q) => q.eq("projectId", project._id))
							.collect();

						await Promise.all([
							workspaces_queue_data_deletion_request(ctx, {
								workspaceId: workspace._id,
								projectId: project._id,
								scope: "workspace",
							}),
							Promise.all(
								projectUsers.map((projectUser) => ctx.db.delete("workspaces_projects_users", projectUser._id)),
							),
							ctx.db.delete("workspaces_projects", project._id),
						]);

						return projectUsers.map((projectUser) => projectUser.userId);
					}),
				)
			).flat(),
		);

		if (workspace.ownerUserId) {
			const ownerUserId = workspace.ownerUserId;
			const limitDefinition = user_limits.EXTRA_WORKSPACES;
			const limit = await ctx.db
				.query("limits_per_user")
				.withIndex("by_userId_limitName", (q) => q.eq("userId", ownerUserId).eq("limitName", limitDefinition.name))
				.first();

			if (limit && limit.usedCount > 0) {
				await ctx.db.patch("limits_per_user", limit._id, {
					usedCount: limit.usedCount - 1,
					updatedAt: now,
				});
			}
		}

		const workspaceLimits = await ctx.db
			.query("limits_per_workspace")
			.withIndex("by_workspaceId_limitName", (q) => q.eq("workspaceId", workspace._id))
			.collect();
		await Promise.all(workspaceLimits.map((limitDoc) => ctx.db.delete("limits_per_workspace", limitDoc._id)));

		await ctx.db.delete("workspaces", workspace._id);
		for (const user_id of affected_user_ids) {
			await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
				userId: user_id,
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
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

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
											.withIndex("by_projectId_userId", (q) =>
												q.eq("projectId", defaultProjectId).eq("userId", user.id),
											)
											.first()
									: null,
							] as const;
						})),
					] as const,
			),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", args.projectId))
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
			!(await user_is_project_admin(ctx, { projectId: project._id, userId: user.id })) &&
			!(await user_is_workspace_admin(ctx, { workspaceId: workspace._id, userId: user.id }))
		) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		const affected_user_ids = new Set<Id<"users">>(projectUserLookup.map((projectUser) => projectUser.userId));

		await workspaces_queue_data_deletion_request(ctx, {
			workspaceId: workspace._id,
			projectId: project._id,
			scope: "project",
		});
		const limitDefinition = workspace_limits.EXTRA_PROJECTS;
		const limit = await ctx.db
			.query("limits_per_workspace")
			.withIndex("by_workspaceId_limitName", (q) =>
				q.eq("workspaceId", workspace._id).eq("limitName", limitDefinition.name),
			)
			.first();

		if (limit && limit.usedCount > 0) {
			await ctx.db.patch("limits_per_workspace", limit._id, {
				usedCount: limit.usedCount - 1,
				updatedAt: now,
			});
		}
		await Promise.all(
			projectUserLookup.map((projectUser) => ctx.db.delete("workspaces_projects_users", projectUser._id)),
		);

		await ctx.db.delete("workspaces_projects", project._id);
		for (const user_id of affected_user_ids) {
			await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
				userId: user_id,
				now: Date.now(),
			});
		}

		return Result({
			_yay: null,
		});
	},
});
