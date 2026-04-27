import { describe, expect, test } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { presence } from "./presence.ts";
import { test_convex } from "./setup.test.ts";
import { data_deletion_db_request } from "../server/data_deletion.ts";
import {
	workspaces_db_create,
	workspaces_db_create_project,
	workspaces_db_ensure_default_workspace_and_project_for_user,
} from "./workspaces.ts";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { pages_create_room_id } from "../shared/pages.ts";
import { app_presence_GLOBAL_ROOM_ID } from "../shared/shared-presence-constants.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function data_deletion_test_bootstrap_user(
	ctx: MutationCtx,
	args: { clerkUserId: string; displayName: string; avatarUrl?: string; email?: string },
) {
	const now = Date.now();
	const userId = await ctx.db.insert("users", {
		clerkUserId: args.clerkUserId,
	});

	await Promise.all([
		quotas_db_ensure(ctx, {
			quotaName: "extra_workspaces",
			userId,
			now,
		}),
		ctx.db
			.insert("users_anagraphics", {
				userId,
				displayName: args.displayName,
				avatarUrl: args.avatarUrl,
				email: args.email ?? "",
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
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		pageId: pageId,
		content: `# ${args.tag}`,
		isArchived: false,
		yjsSequence: 0,
		updatedAt: Date.now(),
		updatedBy: args.userId,
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
			const workspaceRequestIdAfterProject = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
			});

			return {
				userRequestId,
				userRequestIdAgain,
				workspaceRequestId,
				workspaceRequestIdAgain,
				workspaceRequestIdAfterProject,
				projectRequestId,
				projectRequestIdAgain,
				rows: await ctx.db.query("data_deletion_requests").collect(),
			};
		});

		expect(requests.userRequestId).toBe(requests.userRequestIdAgain);
		expect(requests.workspaceRequestId).toBe(requests.workspaceRequestIdAgain);
		expect(requests.workspaceRequestId).toBe(requests.workspaceRequestIdAfterProject);
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

describe("init_user_deletion", () => {
	test("only tombstones the user and deactivates memberships during phase 1", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-phase-one",
				displayName: "Phase One User",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-phase-one-collaborator",
				displayName: "Phase One Collaborator",
			}),
		);

		const sharedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: collaborator.userId,
				name: "phase-one-shared",
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
				userId: deletedUser.userId,
				active: true,
			});

			const extraProject = await workspaces_db_create_project(ctx, {
				userId: collaborator.userId,
				workspaceId: created._yay.workspaceId,
				name: "p1-shared-extra",
				description: "",
				now: Date.now(),
			});
			if (extraProject._nay) {
				throw new Error(extraProject._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: extraProject._yay.projectId,
				userId: deletedUser.userId,
				active: true,
			});

			return {
				workspaceId: created._yay.workspaceId,
				defaultProjectId: created._yay.defaultProjectId,
				extraProjectId: extraProject._yay.projectId,
			} as const;
		});

		await t.run(async (ctx) => {
			await Promise.all([
				data_deletion_test_seed_page(ctx, {
					userId: deletedUser.userId,
					workspaceId: String(deletedUser.defaultWorkspaceId),
					projectId: String(deletedUser.defaultProjectId),
					tag: "phase-one-personal-page",
				}),
				data_deletion_test_seed_page(ctx, {
					userId: deletedUser.userId,
					workspaceId: String(sharedWorkspace.workspaceId),
					projectId: String(sharedWorkspace.extraProjectId),
					tag: "phase-one-shared-extra-page",
				}),
				ctx.db.insert("billing_usage_snapshots", {
					userId: deletedUser.userId,
					polarCustomerId: "cust_phase_one",
					subscription: null,
					meter: null,
					lastSyncedAt: 11_111,
				}),
			]);
		});

		const sharedPresenceRoomId = pages_create_room_id(
			String(sharedWorkspace.workspaceId),
			String(sharedWorkspace.extraProjectId),
			"phase-one-shared-presence-page",
		);
		await t.run(async (ctx) => {
			await Promise.all([
				ctx.runMutation(components.presence.public.heartbeat, {
					roomId: app_presence_GLOBAL_ROOM_ID,
					userId: deletedUser.userId,
					sessionId: "phase-one-deleted-global",
					interval: 10_000,
				}),
				ctx.runMutation(components.presence.public.heartbeat, {
					roomId: sharedPresenceRoomId,
					userId: deletedUser.userId,
					sessionId: "phase-one-deleted-shared",
					interval: 10_000,
				}),
				ctx.runMutation(components.presence.public.heartbeat, {
					roomId: sharedPresenceRoomId,
					userId: collaborator.userId,
					sessionId: "phase-one-collaborator-shared",
					interval: 10_000,
				}),
			]);
		});

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 10_001,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [
				user,
				request,
				requests,
				memberships,
				personalWorkspace,
				personalProject,
				sharedWorkspaceDoc,
				sharedExtraProject,
				personalPages,
				sharedExtraPages,
				snapshots,
				deletedPresenceRooms,
				collaboratorPresenceRooms,
			] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("data_deletion_requests", requestId!),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db.get("workspaces", sharedWorkspace.workspaceId),
				ctx.db.get("workspaces_projects", sharedWorkspace.extraProjectId),
				ctx.db
					.query("pages")
					.collect()
					.then((rows) => rows.filter((row) => row.projectId === String(deletedUser.defaultProjectId))),
				ctx.db
					.query("pages")
					.collect()
					.then((rows) => rows.filter((row) => row.projectId === String(sharedWorkspace.extraProjectId))),
				ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				presence.listUser(ctx, deletedUser.userId, false, 10_000),
				presence.listUser(ctx, collaborator.userId, false, 10_000),
			]);

			return {
				user,
				request,
				requests,
				memberships,
				personalWorkspace,
				personalProject,
				sharedWorkspaceDoc,
				sharedExtraProject,
				personalPages,
				sharedExtraPages,
				snapshots,
				deletedPresenceRooms,
				collaboratorPresenceRooms,
			};
		});

		expect(after.user?.deletedAt).toBe(10_001);
		expect(after.user?.clerkUserId).toBe("clerk-user-delete-phase-one");
		expect(after.user?.defaultWorkspaceId).toBe(deletedUser.defaultWorkspaceId);
		expect(after.user?.defaultProjectId).toBe(deletedUser.defaultProjectId);
		expect(after.request?._id).toBe(requestId);
		expect(after.requests).toHaveLength(1);
		expect(after.requests[0]?.scope).toBe("user");
		expect(after.memberships.length).toBeGreaterThan(0);
		expect(after.memberships.every((membership) => membership.active === false)).toBe(true);
		expect(after.personalWorkspace?._id).toBe(deletedUser.defaultWorkspaceId);
		expect(after.personalProject?._id).toBe(deletedUser.defaultProjectId);
		expect(after.sharedWorkspaceDoc?._id).toBe(sharedWorkspace.workspaceId);
		expect(after.sharedExtraProject?._id).toBe(sharedWorkspace.extraProjectId);
		expect(after.personalPages).toHaveLength(1);
		expect(after.sharedExtraPages).toHaveLength(1);
		expect(after.snapshots).toHaveLength(1);
		expect(after.deletedPresenceRooms).toHaveLength(0);
		expect(after.collaboratorPresenceRooms.map((room) => room.roomId)).toContain(sharedPresenceRoomId);
	});

	test("allows account deletion after ownership was transferred first", async () => {
		const t = test_convex();
		const owner = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-owned-transfer",
				displayName: "Owned Transfer",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-owned-transfer-collaborator",
				displayName: "Owned Transfer Collaborator",
			}),
		);

		const workspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: owner.userId,
				name: "owned-transfer",
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

			return created._yay;
		});

		const ownerClient = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-owned-transfer-owner",
			external_id: owner.userId,
			name: "Owned Transfer Owner",
			email: "owned-transfer-owner@test.local",
		});
		const transferResult = await ownerClient.mutation(api.access_control.transfer_workspace_ownership, {
			workspaceId: workspace.workspaceId,
			newOwnerUserId: collaborator.userId,
		});
		expect(transferResult._nay).toBeUndefined();

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: owner.userId,
				nowTs: 42_002,
			}),
		);

		expect(requestId).toBeTruthy();
		const after = await t.run(async (ctx) => {
			const [user, ownerRole, workspaceDoc, collaboratorQuota, workspaceRequests] = await Promise.all([
				ctx.db.get("users", owner.userId),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_project_role_user", (q) =>
						q.eq("workspaceId", workspace.workspaceId).eq("projectId", workspace.defaultProjectId).eq("role", "owner"),
					)
					.first(),
				ctx.db.get("workspaces", workspace.workspaceId),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) =>
						q.eq("userId", collaborator.userId).eq("quotaName", "extra_workspaces"),
					)
					.first(),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_workspace_scope", (q) => q.eq("workspaceId", workspace.workspaceId).eq("scope", "workspace"))
					.collect(),
			]);

			return { user, ownerRole, workspaceDoc, collaboratorQuota, workspaceRequests };
		});

		expect(after.user?.deletedAt).toBe(42_002);
		expect(after.ownerRole?.userId).toBe(collaborator.userId);
		expect(after.workspaceDoc).not.toBeNull();
		expect(after.collaboratorQuota?.usedCount).toBe(1);
		expect(after.workspaceRequests).toHaveLength(0);
	});

	test("queues remaining owned workspace deletion and removes memberships immediately", async () => {
		const t = test_convex();
		const owner = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-owned-delete",
				displayName: "Owned Delete",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-owned-delete-collaborator",
				displayName: "Owned Delete Collaborator",
			}),
		);

		const workspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: owner.userId,
				name: "owned-delete",
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

			return created._yay;
		});

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: owner.userId,
				nowTs: 42_003,
			}),
		);

		expect(requestId).toBeTruthy();
		const after = await t.run(async (ctx) => {
			const [user, workspaceDoc, ownerRoles, permissionGrants, memberships, requests, ownerQuota] = await Promise.all([
				ctx.db.get("users", owner.userId),
				ctx.db.get("workspaces", workspace.workspaceId),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_project_role_user", (q) =>
						q.eq("workspaceId", workspace.workspaceId).eq("projectId", workspace.defaultProjectId).eq("role", "owner"),
					)
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_workspace_project_resource_user_permission", (q) => q.eq("workspaceId", workspace.workspaceId))
					.collect(),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_active_workspace_project_user", (q) =>
						q.eq("active", true).eq("workspaceId", workspace.workspaceId),
					)
					.collect(),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_workspace_scope", (q) => q.eq("workspaceId", workspace.workspaceId).eq("scope", "workspace"))
					.collect(),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) =>
						q.eq("userId", owner.userId).eq("quotaName", "extra_workspaces"),
					)
					.first(),
			]);

			return { user, workspaceDoc, ownerRoles, permissionGrants, memberships, requests, ownerQuota };
		});

		expect(after.user?.deletedAt).toBe(42_003);
		expect(after.workspaceDoc).not.toBeNull();
		expect(after.ownerRoles).toHaveLength(0);
		expect(after.permissionGrants).toHaveLength(0);
		expect(after.memberships).toHaveLength(0);
		expect(after.requests).toHaveLength(1);
		expect(after.ownerQuota?.usedCount).toBe(0);
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
				userId: collaborator.userId,
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
				userId: deletedUser.userId,
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
					.withIndex("by_workspace_project_name", (q) =>
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
			const request = await ctx.db.get("data_deletion_requests", requestId!);
			return request!._creationTime;
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId: requestId!,
				_test_now: requestCreationTime + RETENTION_MS + 1,
			}),
		);

		const afterUserDeletion = await t.run(async (ctx) => {
			const [
				user,
				anagraphic,
				memberships,
				roleAssignments,
				permissionGrants,
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
					.query("access_control_role_assignments")
					.withIndex("by_user_role_workspace_project", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_user_workspace_project_resource_permission", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("pages_pending_edits")
					.withIndex("by_user_page", (q) => q.eq("userId", String(deletedUser.userId)))
					.collect(),
				ctx.db
					.query("pages_pending_edits_last_sequence_saved")
					.withIndex("by_user_page", (q) => q.eq("userId", String(deletedUser.userId)))
					.collect(),
				ctx.db.query("pages_pending_edits_cleanup_tasks").collect(),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db.get("workspaces", sharedWorkspace.workspaceId),
				ctx.db
					.query("pages")
					.withIndex("by_workspace_project_name", (q) =>
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
				roleAssignments,
				permissionGrants,
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
		expect(afterUserDeletion.roleAssignments).toHaveLength(0);
		expect(afterUserDeletion.permissionGrants).toHaveLength(0);
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

	test("clears user quota docs when the queued request runs after the user doc is gone", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-missing-user-quota",
				displayName: "Missing User Quota",
			}),
		);

		const requestId = await t.run(async (ctx) => {
			const requestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				scope: "user",
			});

			await ctx.db.delete("users", deletedUser.userId);

			return requestId;
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [request, userQuotaDocs] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
			]);

			return {
				request,
				userQuotaDocs,
			};
		});

		expect(after.request).toBeNull();
		expect(after.userQuotaDocs).toHaveLength(0);
	});

	test("keeps shared orphaned projects after retention when the workspace still has active users", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-shared-orphan",
				displayName: "Deleted Shared Orphan User",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-shared-orphan-collaborator",
				displayName: "Shared Orphan Collaborator",
			}),
		);

		const sharedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: collaborator.userId,
				name: "shared-orphan-space",
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
				userId: deletedUser.userId,
				active: true,
			});

			const extraProject = await workspaces_db_create_project(ctx, {
				userId: deletedUser.userId,
				workspaceId: created._yay.workspaceId,
				name: "shared-orphan-extra",
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
			} as const;
		});

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(sharedWorkspace.workspaceId),
				projectId: String(sharedWorkspace.extraProjectId),
				tag: "shared-orphan-retained-page",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 20_001,
			}),
		);
		const requestCreationTime = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId!);
			return request!._creationTime;
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId: requestId!,
				_test_now: requestCreationTime + RETENTION_MS + 1,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [user, sharedWorkspaceDoc, sharedDefaultProject, sharedExtraProject, sharedExtraPages, memberships] =
				await Promise.all([
					ctx.db.get("users", deletedUser.userId),
					ctx.db.get("workspaces", sharedWorkspace.workspaceId),
					ctx.db.get("workspaces_projects", sharedWorkspace.defaultProjectId),
					ctx.db.get("workspaces_projects", sharedWorkspace.extraProjectId),
					ctx.db
						.query("pages")
						.collect()
						.then((rows) => rows.filter((row) => row.projectId === String(sharedWorkspace.extraProjectId))),
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", deletedUser.userId))
						.collect(),
				]);

			return {
				user,
				sharedWorkspaceDoc,
				sharedDefaultProject,
				sharedExtraProject,
				sharedExtraPages,
				memberships,
			};
		});

		expect(after.user?.deletedAt).toBe(20_001);
		expect(after.user?.defaultWorkspaceId).toBeUndefined();
		expect(after.sharedWorkspaceDoc?._id).toBe(sharedWorkspace.workspaceId);
		expect(after.sharedDefaultProject?._id).toBe(sharedWorkspace.defaultProjectId);
		expect(after.sharedExtraProject?._id).toBe(sharedWorkspace.extraProjectId);
		expect(after.sharedExtraPages).toHaveLength(1);
		expect(after.memberships).toHaveLength(0);
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
			const [workspaceDoc, defaultProjectDoc, extraProjectDoc, workspaceRequest, projectRequest, pages, workspaceQuotaDocs] =
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
					ctx.db
						.query("quotas")
						.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", workspace.workspaceId))
						.collect(),
				]);

			return {
				workspaceDoc,
				defaultProjectDoc,
				extraProjectDoc,
				workspaceRequest,
				projectRequest,
				pages,
				workspaceQuotaDocs,
			};
		});

		expect(after.workspaceDoc).toBeNull();
		expect(after.defaultProjectDoc).toBeNull();
		expect(after.extraProjectDoc).toBeNull();
		expect(after.workspaceRequest).toBeNull();
		expect(after.projectRequest).toBeNull();
		expect(after.pages).toHaveLength(0);
		expect(after.workspaceQuotaDocs).toHaveLength(0);
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
				ctx.db.get("data_deletion_requests", requestId!),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db
					.query("pages")
					.collect()
					.then((rows) => rows.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId))),
				ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
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

	test("keeps shared orphaned projects while deleting the user data directly", async () => {
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

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
				userId: deletedUser.userId,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [user, requests, sharedWorkspaceDoc, sharedDefaultProject, sharedExtraProject, extraProjectPages] =
				await Promise.all([
					ctx.db.get("users", deletedUser.userId),
					ctx.db.query("data_deletion_requests").collect(),
					ctx.db.get("workspaces", sharedWorkspace.workspaceId),
					ctx.db.get("workspaces_projects", sharedWorkspace.defaultProjectId),
					ctx.db.get("workspaces_projects", sharedWorkspace.extraProjectId),
					ctx.db
						.query("pages")
						.collect()
						.then((rows) => rows.filter((row) => row.projectId === String(sharedWorkspace.extraProjectId))),
				]);

			return {
				user,
				requests,
				sharedWorkspaceDoc,
				sharedDefaultProject,
				sharedExtraProject,
				extraProjectPages,
			};
		});

		expect(after.user?.deletedAt).toBeTypeOf("number");
		expect(after.requests).toHaveLength(0);
		expect(after.sharedWorkspaceDoc?._id).toBe(sharedWorkspace.workspaceId);
		expect(after.sharedDefaultProject?._id).toBe(sharedWorkspace.defaultProjectId);
		expect(after.sharedExtraProject?._id).toBe(sharedWorkspace.extraProjectId);
		expect(after.extraProjectPages).toHaveLength(1);
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
			const row = await ctx.db.get("data_deletion_requests", rid!);
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
			const row = await ctx.db.get("data_deletion_requests", rid!);
			if (!row) {
				throw new Error("Expected user deletion request");
			}

			return {
				userRequestId: rid!,
				projectRequestId: queuedProjectRequestId,
				test_now: Math.max(row._creationTime, queuedProjectRequest._creationTime) + RETENTION_MS + 1,
			};
		});

		await t.action(internal.data_deletion.process_deletion_requests, { _test_now: test_now });

		const after = await t.run(async (ctx) => {
			const [userRequest, projectRequest, requests, workspace, project, pages] = await Promise.all([
				ctx.db.get("data_deletion_requests", userRequestId!),
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
	test("reclaims the same user row during retention and preserves default content", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-retention",
				displayName: "Returning User",
				email: "returning-user-retention@test.local",
			}),
		);
		const recoveryEmail = "returning-user-retention@test.local";

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(deletedUser.defaultWorkspaceId),
				projectId: String(deletedUser.defaultProjectId),
				tag: "retained-personal-page",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_101,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-retention-again",
				email: recoveryEmail,
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [user, request, memberships, anagraphic, pages] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("data_deletion_requests", requestId!),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
				ctx.db
					.query("pages")
					.collect()
					.then((rows) => rows.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId))),
			]);

			return {
				user,
				request,
				memberships,
				anagraphic,
				pages,
			};
		});

		expect(result._yay.userId).toBe(deletedUser.userId);
		expect(after.user?.deletedAt).toBeUndefined();
		expect(after.user?.clerkUserId).toBe("clerk-user-delete-return-retention-again");
		expect(after.user?.defaultWorkspaceId).toBe(deletedUser.defaultWorkspaceId);
		expect(after.user?.defaultProjectId).toBe(deletedUser.defaultProjectId);
		expect(after.request).toBeNull();
		expect(after.memberships.length).toBeGreaterThan(0);
		expect(after.memberships.every((membership) => membership.active !== false)).toBe(true);
		expect(after.anagraphic?.email).toBe(recoveryEmail);
		expect(after.pages).toHaveLength(1);
	});

	test("reclaims the same user row during retention and returns the billing restore marker", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-billing",
				displayName: "Returning Billing User",
				email: "returning-billing-user@test.local",
			}),
		);
		const recoveryEmail = "returning-billing-user@test.local";

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_returning_billing_user",
			userId: deletedUser.userId,
		});
		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: "prod_returning_billing_user",
				organizationId: "returning_billing_org",
				name: "Returning Billing Product",
				description: "Returning billing product",
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [],
				medias: [],
				benefits: [],
			},
		});
		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_returning_billing_user",
				customerId: "cust_returning_billing_user",
				productId: "prod_returning_billing_user",
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "eur",
				recurringInterval: "month",
				status: "active",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: true,
				canceledAt: "2026-01-15T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:00.000Z",
				endsAt: "2026-02-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_201,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-billing-again",
				email: recoveryEmail,
				displayName: "Returning Billing User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId!);

			return {
				request,
			};
		});

		expect(result._yay.restoredDeletedAccount).toBe(true);
		expect(after.request).toBeNull();
	});

	test("reclaims the same user row after retention purge and recreates default tenant state", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return",
				displayName: "Returning User",
				email: "returning-user@test.local",
			}),
		);
		const recoveryEmail = "returning-user@test.local";

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_returning_user",
			userId: deletedUser.userId,
		});

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_001,
			}),
		);
		const requestCreationTime2 = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId!);
			return request!._creationTime;
		});
		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId: requestId!,
				_test_now: requestCreationTime2 + RETENTION_MS + 1,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return",
				email: recoveryEmail,
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [user, customer, quota, anagraphic] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.runQuery(components.polar.lib.getCustomerByUserId, {
					userId: deletedUser.userId,
				}),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) =>
						q.eq("userId", deletedUser.userId).eq("quotaName", "extra_workspaces"),
					)
					.first(),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
			]);

			const [workspace, project] =
				user?.defaultWorkspaceId && user.defaultProjectId
					? await Promise.all([
							ctx.db.get("workspaces", user.defaultWorkspaceId),
							ctx.db.get("workspaces_projects", user.defaultProjectId),
						])
					: [null, null];

			return {
				user,
				customer,
				quota,
				anagraphic,
				workspace,
				project,
			};
		});

		expect(result._yay.userId).toBe(deletedUser.userId);
		expect(after.user?.deletedAt).toBeUndefined();
		expect(after.user?.clerkUserId).toBe("clerk-user-delete-return");
		expect(after.user?.defaultWorkspaceId).toBeDefined();
		expect(after.user?.defaultWorkspaceId).not.toBe(deletedUser.defaultWorkspaceId);
		expect(after.user?.defaultProjectId).toBeDefined();
		expect(after.user?.defaultProjectId).not.toBe(deletedUser.defaultProjectId);
		expect(after.workspace?._id).toBe(after.user?.defaultWorkspaceId);
		expect(after.project?._id).toBe(after.user?.defaultProjectId);
		expect(after.customer?.id).toBe("cust_returning_user");
		expect(after.quota).not.toBeNull();
		expect(after.anagraphic?.email).toBe(recoveryEmail);
	});

	test("creates a fresh user row when the returning email does not match", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-non-match",
				displayName: "Returning User",
				email: "returning-user-non-match@test.local",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_001,
			}),
		);
		const requestCreationTime = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId!);
			return request!._creationTime;
		});
		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId: requestId!,
				_test_now: requestCreationTime + RETENTION_MS + 1,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-non-match-again",
				email: "somebody-else@test.local",
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
		expect(after.newUser?.clerkUserId).toBe("clerk-user-delete-return-non-match-again");
		expect(after.newUser?.deletedAt).toBeUndefined();
	});

	test("prefers the deleted account over an anonymous session during reclaim", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-anon",
				displayName: "Returning User",
				email: "returning-user-anon@test.local",
			}),
		);
		const recoveryEmail = "returning-user-anon@test.local";

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_301,
			}),
		);
		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: "data_deletion_anonymous_free_product",
				organizationId: "data_deletion_test_org",
				name: billing_PRODUCTS.Free.name,
				description: null,
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [],
				medias: [],
				benefits: [],
			},
		});

		const anonymousResponse = await t.fetch("/api/auth/anonymous", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		const anonymousPayload = (await anonymousResponse.json()) as { token: string; userId: Id<"users"> };

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-anon-again",
				email: recoveryEmail,
				anonymousUserToken: anonymousPayload.token,
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [reclaimedUser, anonymousUser] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users", anonymousPayload.userId),
			]);

			return {
				reclaimedUser,
				anonymousUser,
			};
		});

		expect(result._yay.userId).toBe(deletedUser.userId);
		expect(after.reclaimedUser?.deletedAt).toBeUndefined();
		expect(after.reclaimedUser?.clerkUserId).toBe("clerk-user-delete-return-anon-again");
		expect(after.anonymousUser?._id).toBe(anonymousPayload.userId);
		expect(after.anonymousUser?.clerkUserId).toBeNull();
	});

	test("removes only the user deletion request while leaving resource delete requests intact", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-resource-request",
				displayName: "Returning User",
				email: "returning-user-resource-request@test.local",
			}),
		);
		const recoveryEmail = "returning-user-resource-request@test.local";

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_401,
			}),
		);
		const resourceDeleteProjectRequestId = await t.run(async (ctx) => {
			const workspace = await workspaces_db_create(ctx, {
				userId: deletedUser.userId,
				name: "restore-req-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (workspace._nay) {
				throw new Error(workspace._nay.message);
			}

			const project = await workspaces_db_create_project(ctx, {
				userId: deletedUser.userId,
				workspaceId: workspace._yay.workspaceId,
				name: "restore-req-proj",
				description: "",
				now: Date.now(),
			});
			if (project._nay) {
				throw new Error(project._nay.message);
			}

			return await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: project._yay.projectId,
				scope: "project",
			});
		});

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-resource-request-again",
				email: recoveryEmail,
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [userRequest, resourceDeleteProjectRequest] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId!),
				ctx.db.get("data_deletion_requests", resourceDeleteProjectRequestId),
			]);

			return {
				userRequest,
				resourceDeleteProjectRequest,
			};
		});

		expect(after.userRequest).toBeNull();
		expect(after.resourceDeleteProjectRequest?._id).toBe(resourceDeleteProjectRequestId);
	});

	test("purges the stored recovery email after hard delete and falls back to a fresh user later", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-purge",
				displayName: "Returning User",
				email: "returning-user-purge@test.local",
			}),
		);
		const recoveryEmail = "returning-user-purge@test.local";

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
				userId: deletedUser.userId,
			}),
		);
		await t.run((ctx) =>
			ctx.runMutation(internal.users.purge_deleted_user_tombstone, {
				userId: deletedUser.userId,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-purge-again",
				email: recoveryEmail,
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [oldUser, newUser, oldAnagraphic] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users", result._yay.userId),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
			]);

			return {
				oldUser,
				newUser,
				oldAnagraphic,
			};
		});

		expect(after.oldUser).toBeNull();
		expect(result._yay.userId).not.toBe(deletedUser.userId);
		expect(after.newUser?.clerkUserId).toBe("clerk-user-delete-return-purge-again");
		expect(after.oldAnagraphic).toBeNull();
	});
});
