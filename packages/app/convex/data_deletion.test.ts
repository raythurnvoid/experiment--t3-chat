import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex } from "./setup.test.ts";
import { data_deletion_db_request } from "../server/data_deletion.ts";
import {
	workspaces_db_create,
	workspaces_db_create_project,
	workspaces_db_ensure_default_workspace_and_project_for_user,
} from "../server/workspaces.ts";
import { user_limits } from "../shared/limits.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function data_deletion_test_bootstrap_user(
	ctx: MutationCtx,
	args: { clerkUserId: string; displayName: string; avatarUrl?: string },
) {
	const now = Date.now();
	const userId = await ctx.db.insert("users", {
		clerkUserId: args.clerkUserId,
	});

	await Promise.all([
		ctx.db.insert("limits_per_user", {
			userId,
			limitName: user_limits.EXTRA_WORKSPACES.name,
			usedCount: 0,
			maxCount: user_limits.EXTRA_WORKSPACES.maxCount,
			createdAt: now,
			updatedAt: now,
		}),
		ctx.db
			.insert("users_anagraphics", {
				userId,
				displayName: args.displayName,
				avatarUrl: args.avatarUrl,
				updatedAt: now,
			})
			.then((anagraphicId) =>
				ctx.db.patch("users", userId, {
					anagraphic: anagraphicId,
				}),
			),
	]);

	await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
		userId,
		now,
	});

	const user = await ctx.db.get("users", userId);
	if (!user?.defaultWorkspaceId || !user.defaultProjectId || !user.anagraphic) {
		throw new Error("Failed to bootstrap user");
	}

	return {
		userId,
		defaultWorkspaceId: user.defaultWorkspaceId,
		defaultProjectId: user.defaultProjectId,
		anagraphicId: user.anagraphic,
	} as const;
}

async function data_deletion_test_seed_page(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		workspaceId: string;
		projectId: string;
		tag: string;
	},
) {
	const pageId = await ctx.db.insert("pages", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		path: `/${args.tag}`,
		name: args.tag,
		version: 0,
		parentId: "root",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
	});

	await ctx.db.insert("pages_markdown_content", {
		workspace_id: args.workspaceId,
		project_id: args.projectId,
		page_id: pageId,
		content: `# ${args.tag}`,
		is_archived: false,
		yjs_sequence: 0,
		updated_at: Date.now(),
		updated_by: args.userId,
	});

	return {
		pageId,
	} as const;
}

describe("data_deletion_db_request", () => {
	test("dedupes user, workspace, and project requests", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-dedup",
				displayName: "Dedup User",
			}),
		);

		const workspace = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId: user.userId,
				name: "dedup-space",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		if (workspace._nay) {
			throw new Error(workspace._nay.message);
		}

		const extraProject = await t.run(async (ctx) =>
			workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				name: "dedup-extra-project",
				description: "",
				now: Date.now(),
			}),
		);
		if (extraProject._nay) {
			throw new Error(extraProject._nay.message);
		}

		const requests = await t.run(async (ctx) => {
			const userRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				scope: "user",
			});
			const userRequestIdAgain = await data_deletion_db_request(ctx, {
				userId: user.userId,
				scope: "user",
			});

			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
			});
			const workspaceRequestIdAgain = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
			});

			const projectRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: extraProject._yay.projectId,
				scope: "project",
			});
			const projectRequestIdAgain = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: extraProject._yay.projectId,
				scope: "project",
			});

			return {
				userRequestId,
				userRequestIdAgain,
				workspaceRequestId,
				workspaceRequestIdAgain,
				projectRequestId,
				projectRequestIdAgain,
				rows: await ctx.db.query("data_deletion_requests").collect(),
			};
		});

		expect(requests.userRequestId).toBe(requests.userRequestIdAgain);
		expect(requests.workspaceRequestId).toBe(requests.workspaceRequestIdAgain);
		expect(requests.projectRequestId).toBe(requests.projectRequestIdAgain);
		expect(requests.rows).toHaveLength(3);
		expect(requests.rows.filter((row) => row.scope === "user")).toHaveLength(1);
		expect(
			requests.rows.filter((row) => row.scope === "workspace" && row.workspaceId === workspace._yay.workspaceId),
		).toHaveLength(1);
		expect(
			requests.rows.filter(
				(row) =>
					row.scope === "project" &&
					row.workspaceId === workspace._yay.workspaceId &&
					row.projectId === extraProject._yay.projectId,
			),
		).toHaveLength(1);
	});
});

describe("process_user_deletion_request", () => {
	test("tombstones the user, preserves shared content, and directly purges empty personal workspaces", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-main",
				displayName: "Deleted User",
				avatarUrl: "https://example.com/avatar.png",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-collaborator",
				displayName: "Collaborator",
			}),
		);

		const sharedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: deletedUser.userId,
				name: "shared-space",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: created._yay.defaultProjectId,
				userId: collaborator.userId,
				active: true,
			});

			await ctx.db.insert("pages_pending_edits", {
				workspaceId: String(created._yay.workspaceId),
				projectId: String(created._yay.defaultProjectId),
				userId: String(deletedUser.userId),
				pageId: (
					await data_deletion_test_seed_page(ctx, {
						userId: deletedUser.userId,
						workspaceId: String(created._yay.workspaceId),
						projectId: String(created._yay.defaultProjectId),
						tag: "shared-page",
					})
				).pageId,
				baseYjsSequence: 0,
				baseYjsUpdate: new ArrayBuffer(0),
				stagedBranchYjsUpdate: new ArrayBuffer(0),
				unstagedBranchYjsUpdate: new ArrayBuffer(0),
				updatedAt: Date.now(),
			});

			await ctx.db.insert("pages_pending_edits_last_sequence_saved", {
				workspaceId: String(created._yay.workspaceId),
				projectId: String(created._yay.defaultProjectId),
				userId: String(deletedUser.userId),
				pageId: await ctx.db
					.query("pages")
					.withIndex("by_workspaceId_projectId_name", (q) =>
						q
							.eq("workspaceId", String(created._yay.workspaceId))
							.eq("projectId", String(created._yay.defaultProjectId))
							.eq("name", "shared-page"),
					)
					.first()
					.then((page) => {
						if (!page) {
							throw new Error("shared page not found");
						}

						return page._id;
					}),
				lastSequenceSaved: 0,
				updatedAt: Date.now(),
			});

			return created._yay;
		});

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(deletedUser.defaultWorkspaceId),
				projectId: String(deletedUser.defaultProjectId),
				tag: "personal-page",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 10_001,
			}),
		);

		const requestCreationTime = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId);
			return request!._creationTime;
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: requestCreationTime + RETENTION_MS + 1,
			}),
		);

		const afterUserDeletion = await t.run(async (ctx) => {
			const [
				user,
				anagraphic,
				memberships,
				pendingEdits,
				pendingEditSaves,
				cleanupTasks,
				purgeRequests,
				personalWorkspace,
				personalProject,
				sharedWorkspaceDoc,
				sharedPages,
				personalPages,
			] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("pages_pending_edits")
					.withIndex("by_userId_pageId", (q) => q.eq("userId", String(deletedUser.userId)))
					.collect(),
				ctx.db
					.query("pages_pending_edits_last_sequence_saved")
					.withIndex("by_userId_pageId", (q) => q.eq("userId", String(deletedUser.userId)))
					.collect(),
				ctx.db.query("pages_pending_edits_cleanup_tasks").collect(),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db.get("workspaces", sharedWorkspace.workspaceId),
				ctx.db
					.query("pages")
					.withIndex("by_workspaceId_projectId_name", (q) =>
						q
							.eq("workspaceId", String(sharedWorkspace.workspaceId))
							.eq("projectId", String(sharedWorkspace.defaultProjectId))
							.eq("name", "shared-page"),
					)
					.collect(),
				ctx.db
					.query("pages")
					.collect()
					.then((rows) => rows.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId))),
			]);

			return {
				user,
				anagraphic,
				memberships,
				pendingEdits,
				pendingEditSaves,
				cleanupTasks,
				purgeRequests,
				personalWorkspace,
				personalProject,
				sharedWorkspaceDoc,
				sharedPages,
				personalPages,
			};
		});

		expect(afterUserDeletion.user?.deletedAt).toBe(10_001);
		expect(afterUserDeletion.user?.clerkUserId).toBeNull();
		expect(afterUserDeletion.user?.defaultWorkspaceId).toBeUndefined();
		expect(afterUserDeletion.user?.defaultProjectId).toBeUndefined();
		expect(afterUserDeletion.anagraphic?.displayName).toBe("Deleted User");
		expect(afterUserDeletion.memberships).toHaveLength(0);
		expect(afterUserDeletion.pendingEdits).toHaveLength(0);
		expect(afterUserDeletion.pendingEditSaves).toHaveLength(0);
		expect(afterUserDeletion.cleanupTasks).toHaveLength(0);
		expect(afterUserDeletion.personalWorkspace).toBeNull();
		expect(afterUserDeletion.personalProject).toBeNull();
		expect(afterUserDeletion.personalPages).toHaveLength(0);
		expect(afterUserDeletion.sharedWorkspaceDoc?._id).toBe(sharedWorkspace.workspaceId);
		expect(afterUserDeletion.purgeRequests).toHaveLength(0);
		expect(afterUserDeletion.sharedPages).toHaveLength(1);
	});
});

describe("process_workspace_deletion_request", () => {
	test("purges the whole workspace and clears matching queued project requests", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-workspace-request",
				displayName: "Delete Workspace Request",
			}),
		);

		const workspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: user.userId,
				name: "workspace-request",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			return created._yay;
		});

		const extraProject = await t.run(async (ctx) => {
			const created = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: workspace.workspaceId,
				name: "ws-req-extra",
				description: "",
				now: Date.now(),
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			return created._yay;
		});

		await t.run(async (ctx) => {
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				workspaceId: String(workspace.workspaceId),
				projectId: String(workspace.defaultProjectId),
				tag: "workspace-request-default-page",
			});
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				workspaceId: String(workspace.workspaceId),
				projectId: String(extraProject.projectId),
				tag: "workspace-request-extra-page",
			});
		});

		const { workspaceRequestId, projectRequestId, test_now } = await t.run(async (ctx) => {
			const projectRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace.workspaceId,
				projectId: extraProject.projectId,
				scope: "project",
			});
			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace.workspaceId,
				scope: "workspace",
			});
			const workspaceRequest = await ctx.db.get("data_deletion_requests", workspaceRequestId);
			if (!workspaceRequest) {
				throw new Error("Expected queued workspace deletion request");
			}

			return {
				workspaceRequestId,
				projectRequestId,
				test_now: workspaceRequest._creationTime + RETENTION_MS + 1,
			};
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId: workspaceRequestId,
				_test_now: test_now,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [workspaceDoc, defaultProjectDoc, extraProjectDoc, workspaceRequest, projectRequest, pages] =
				await Promise.all([
					ctx.db.get("workspaces", workspace.workspaceId),
					ctx.db.get("workspaces_projects", workspace.defaultProjectId),
					ctx.db.get("workspaces_projects", extraProject.projectId),
					ctx.db.get("data_deletion_requests", workspaceRequestId),
					ctx.db.get("data_deletion_requests", projectRequestId),
					ctx.db
						.query("pages")
						.collect()
						.then((rows) => rows.filter((row) => row.workspaceId === String(workspace.workspaceId))),
				]);

			return {
				workspaceDoc,
				defaultProjectDoc,
				extraProjectDoc,
				workspaceRequest,
				projectRequest,
				pages,
			};
		});

		expect(after.workspaceDoc).toBeNull();
		expect(after.defaultProjectDoc).toBeNull();
		expect(after.extraProjectDoc).toBeNull();
		expect(after.workspaceRequest).toBeNull();
		expect(after.projectRequest).toBeNull();
		expect(after.pages).toHaveLength(0);
	});
});

describe("hard_delete_user_data", () => {
	test("directly purges local data and only clears matching request rows", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-direct",
				displayName: "Hard Delete Data Direct",
			}),
		);
		const unrelatedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-unrelated",
				displayName: "Unrelated User",
			}),
		);
		const unrelatedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: unrelatedUser.userId,
				name: "hd-unrelated",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			return created._yay;
		});

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(deletedUser.defaultWorkspaceId),
				projectId: String(deletedUser.defaultProjectId),
				tag: "direct-user-purge-page",
			}),
		);

		const requestIds = await t.run(async (ctx) => {
			const userRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				scope: "user",
			});
			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				workspaceId: deletedUser.defaultWorkspaceId,
				scope: "workspace",
			});
			const projectRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				workspaceId: deletedUser.defaultWorkspaceId,
				projectId: deletedUser.defaultProjectId,
				scope: "project",
			});
			const unrelatedProjectRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				workspaceId: unrelatedWorkspace.workspaceId,
				projectId: unrelatedWorkspace.defaultProjectId,
				scope: "project",
			});

			return {
				userRequestId,
				workspaceRequestId,
				projectRequestId,
				unrelatedProjectRequestId,
			};
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
				userId: deletedUser.userId,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [user, workspace, project, pages, userRequest, workspaceRequest, projectRequest, unrelatedProjectRequest] =
				await Promise.all([
					ctx.db.get("users", deletedUser.userId),
					ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
					ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
					ctx.db
						.query("pages")
						.collect()
						.then((rows) => rows.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId))),
					ctx.db.get("data_deletion_requests", requestIds.userRequestId),
					ctx.db.get("data_deletion_requests", requestIds.workspaceRequestId),
					ctx.db.get("data_deletion_requests", requestIds.projectRequestId),
					ctx.db.get("data_deletion_requests", requestIds.unrelatedProjectRequestId),
				]);

			return {
				user,
				workspace,
				project,
				pages,
				userRequest,
				workspaceRequest,
				projectRequest,
				unrelatedProjectRequest,
			};
		});

		expect(after.user?.deletedAt).toBeTypeOf("number");
		expect(after.user?.clerkUserId).toBeNull();
		expect(after.user?.defaultWorkspaceId).toBeUndefined();
		expect(after.user?.defaultProjectId).toBeUndefined();
		expect(after.workspace).toBeNull();
		expect(after.project).toBeNull();
		expect(after.pages).toHaveLength(0);
		expect(after.userRequest).toBeNull();
		expect(after.workspaceRequest).toBeNull();
		expect(after.projectRequest).toBeNull();
		expect(after.unrelatedProjectRequest?._id).toBe(requestIds.unrelatedProjectRequestId);
	});

	test("finishes a user whose scheduled deletion was already initialized", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-initialized",
				displayName: "Hard Delete Data Initialized",
			}),
		);

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(deletedUser.defaultWorkspaceId),
				projectId: String(deletedUser.defaultProjectId),
				tag: "initialized-user-purge-page",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_001,
			}),
		);

		await t.run((ctx) =>
			ctx.db.insert("billing_usage_snapshots", {
				userId: deletedUser.userId,
				polarCustomerId: "cust_initialized_hard_delete",
				subscription: null,
				meter: null,
				lastSyncedAt: 77_777,
			}),
		);

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
				userId: deletedUser.userId,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [user, request, workspace, project, pages, snapshots] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("data_deletion_requests", requestId),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db
					.query("pages")
					.collect()
					.then((rows) => rows.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId))),
				ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_userId", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
			]);

			return {
				user,
				request,
				workspace,
				project,
				pages,
				snapshots,
			};
		});

		expect(after.user?.deletedAt).toBe(30_001);
		expect(after.user?.clerkUserId).toBeNull();
		expect(after.request).toBeNull();
		expect(after.workspace).toBeNull();
		expect(after.project).toBeNull();
		expect(after.pages).toHaveLength(0);
		expect(after.snapshots).toHaveLength(0);
	});

	test("clears queued orphan project requests while keeping the shared workspace alive", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-shared",
				displayName: "Hard Delete Data Shared",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-collaborator",
				displayName: "Hard Delete Data Collaborator",
			}),
		);

		const sharedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: deletedUser.userId,
				name: "hd-shared",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: created._yay.defaultProjectId,
				userId: collaborator.userId,
				active: true,
			});

			const extraProject = await workspaces_db_create_project(ctx, {
				userId: deletedUser.userId,
				workspaceId: created._yay.workspaceId,
				name: "hd-shared-extra",
				description: "",
				now: Date.now(),
			});
			if (extraProject._nay) {
				throw new Error(extraProject._nay.message);
			}

			return {
				workspaceId: created._yay.workspaceId,
				defaultProjectId: created._yay.defaultProjectId,
				extraProjectId: extraProject._yay.projectId,
			};
		});

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(sharedWorkspace.workspaceId),
				projectId: String(sharedWorkspace.extraProjectId),
				tag: "shared-orphan-project-page",
			}),
		);

		const queuedProjectRequestId = await t.run(async (ctx) => {
			await ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 90_001,
			});

			const queuedProjectRequest = await ctx.db
				.query("data_deletion_requests")
				.withIndex("by_workspace_project", (q) =>
					q.eq("workspaceId", sharedWorkspace.workspaceId).eq("projectId", sharedWorkspace.extraProjectId),
				)
				.first();
			if (!queuedProjectRequest) {
				throw new Error("Expected queued orphan project deletion request");
			}

			return queuedProjectRequest._id;
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
				userId: deletedUser.userId,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [queuedProjectRequest, sharedWorkspaceDoc, sharedDefaultProject, extraProjectPages] = await Promise.all([
				ctx.db.get("data_deletion_requests", queuedProjectRequestId),
				ctx.db.get("workspaces", sharedWorkspace.workspaceId),
				ctx.db.get("workspaces_projects", sharedWorkspace.defaultProjectId),
				ctx.db
					.query("pages")
					.collect()
					.then((rows) => rows.filter((row) => row.projectId === String(sharedWorkspace.extraProjectId))),
			]);

			return {
				queuedProjectRequest,
				sharedWorkspaceDoc,
				sharedDefaultProject,
				extraProjectPages,
			};
		});

		expect(after.queuedProjectRequest).toBeNull();
		expect(after.sharedWorkspaceDoc?._id).toBe(sharedWorkspace.workspaceId);
		expect(after.sharedDefaultProject?._id).toBe(sharedWorkspace.defaultProjectId);
		expect(after.extraProjectPages).toHaveLength(0);
	});

});

describe("list_deletion_request_ids_by_scope", () => {
	test("returns at most limit eligible user-scoped ids across paginated global order", async () => {
		const t = test_convex();
		const maxCreationTime = await t.run(async (ctx) => {
			for (let i = 0; i < 22; i++) {
				const userId = await ctx.db.insert("users", { clerkUserId: `clerk-user-scope-list-${i}` });
				await data_deletion_db_request(ctx, { userId, scope: "user" });
			}
			const rows = await ctx.db.query("data_deletion_requests").collect();
			return Math.max(...rows.map((row) => row._creationTime));
		});
		const listed = await t.run((ctx) =>
			ctx.runQuery(internal.data_deletion.list_deletion_request_ids_by_scope, {
				scope: "user",
				limit: 20,
				_test_now: maxCreationTime + RETENTION_MS + 1,
			}),
		);
		expect(listed).toHaveLength(20);
	});
});

describe("process_deletion_requests", () => {
	test("runs the pipeline on an eligible project deletion request", async () => {
		const t = test_convex();
		const { requestId, test_now } = await t.run(async (ctx) => {
			const user = await data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-pipeline-project",
				displayName: "Pipeline Project",
			});
			const workspace = await workspaces_db_create(ctx, {
				userId: user.userId,
				name: "pipeline-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (workspace._nay) {
				throw new Error(workspace._nay.message);
			}
			const extraProject = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				name: "pipeline-proj",
				description: "",
				now: Date.now(),
			});
			if (extraProject._nay) {
				throw new Error(extraProject._nay.message);
			}
			const rid = await ctx.db.insert("data_deletion_requests", {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: extraProject._yay.projectId,
				scope: "project",
			});
			const row = await ctx.db.get("data_deletion_requests", rid);
			if (!row) {
				throw new Error("Expected purge request");
			}
			return { requestId: rid, test_now: row._creationTime + RETENTION_MS + 1 };
		});
		await t.action(internal.data_deletion.process_deletion_requests, { _test_now: test_now });
		const remaining = await t.run(async (ctx) => ctx.db.get("data_deletion_requests", requestId));
		expect(remaining).toBeNull();
	});

	test("directly consumes an already-queued project request during the user phase in the same run", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-pipeline-user-first",
				displayName: "Pipeline User First",
			}),
		);

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(deletedUser.defaultWorkspaceId),
				projectId: String(deletedUser.defaultProjectId),
				tag: "pipeline-personal-page",
			}),
		);

		const { userRequestId, projectRequestId, test_now } = await t.run(async (ctx) => {
			const queuedProjectRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				workspaceId: deletedUser.defaultWorkspaceId,
				projectId: deletedUser.defaultProjectId,
				scope: "project",
			});
			const queuedProjectRequest = await ctx.db.get("data_deletion_requests", queuedProjectRequestId);
			if (!queuedProjectRequest) {
				throw new Error("Expected queued project deletion request");
			}

			const rid = await ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 40_001,
			});
			const row = await ctx.db.get("data_deletion_requests", rid);
			if (!row) {
				throw new Error("Expected user deletion request");
			}

			return {
				userRequestId: rid,
				projectRequestId: queuedProjectRequestId,
				test_now: Math.max(row._creationTime, queuedProjectRequest._creationTime) + RETENTION_MS + 1,
			};
		});

		await t.action(internal.data_deletion.process_deletion_requests, { _test_now: test_now });

		const after = await t.run(async (ctx) => {
			const [userRequest, projectRequest, requests, workspace, project, pages] = await Promise.all([
				ctx.db.get("data_deletion_requests", userRequestId),
				ctx.db.get("data_deletion_requests", projectRequestId),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db.query("pages").collect(),
			]);

			return {
				userRequest,
				projectRequest,
				requests,
				workspace,
				project,
				pages: pages.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId)),
			};
		});

		expect(after.userRequest).toBeNull();
		expect(after.projectRequest).toBeNull();
		expect(after.requests).toHaveLength(0);
		expect(after.workspace).toBeNull();
		expect(after.project).toBeNull();
		expect(after.pages).toHaveLength(0);
	});

	test("respects the per-scope quotas in one run", async () => {
		const t = test_convex();
		const maxCreationTime = await t.run(async (ctx) => {
			const now = Date.now();

			for (let i = 0; i < 25; i++) {
				const userId = await ctx.db.insert("users", {
					clerkUserId: `clerk-user-quota-user-${i}`,
					deletedAt: now,
				});
				await ctx.db.insert("data_deletion_requests", {
					userId,
					scope: "user",
				});
			}

			for (let i = 0; i < 55; i++) {
				const userId = await ctx.db.insert("users", {
					clerkUserId: `clerk-user-quota-workspace-${i}`,
				});
				const workspaceId = await ctx.db.insert("workspaces", {
					name: `quota-workspace-${i}`,
					description: "",
					default: false,
					updatedAt: now,
				});
				await ctx.db.insert("data_deletion_requests", {
					userId,
					workspaceId,
					scope: "workspace",
				});
			}

			for (let i = 0; i < 205; i++) {
				const userId = await ctx.db.insert("users", {
					clerkUserId: `clerk-user-quota-project-${i}`,
				});
				const workspaceId = await ctx.db.insert("workspaces", {
					name: `quota-project-workspace-${i}`,
					description: "",
					default: false,
					updatedAt: now,
				});
				const projectId = await ctx.db.insert("workspaces_projects", {
					workspaceId,
					name: `quota-project-${i}`,
					description: "",
					default: false,
					updatedAt: now,
				});
				await ctx.db.insert("data_deletion_requests", {
					userId,
					workspaceId,
					projectId,
					scope: "project",
				});
			}

			const rows = await ctx.db.query("data_deletion_requests").collect();
			return Math.max(...rows.map((row) => row._creationTime));
		});

		await t.action(internal.data_deletion.process_deletion_requests, {
			_test_now: maxCreationTime + RETENTION_MS + 1,
		});

		const remaining = await t.run(async (ctx) => ctx.db.query("data_deletion_requests").collect());

		expect(remaining.filter((row) => row.scope === "user")).toHaveLength(5);
		expect(remaining.filter((row) => row.scope === "workspace")).toHaveLength(5);
		expect(remaining.filter((row) => row.scope === "project")).toHaveLength(5);
	});
});

describe("resolve_user after tombstone", () => {
	test("creates a fresh user row for a future sign-up", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return",
				displayName: "Returning User",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_001,
			}),
		);
		const requestCreationTime2 = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId);
			return request!._creationTime;
		});
		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: requestCreationTime2 + RETENTION_MS + 1,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return",
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [oldUser, newUser] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users", result._yay.userId),
			]);

			return {
				oldUser,
				newUser,
			};
		});

		expect(result._yay.userId).not.toBe(deletedUser.userId);
		expect(after.oldUser?.deletedAt).toBe(30_001);
		expect(after.oldUser?.clerkUserId).toBeNull();
		expect(after.newUser?.clerkUserId).toBe("clerk-user-delete-return");
		expect(after.newUser?.deletedAt).toBeUndefined();
	});
});
