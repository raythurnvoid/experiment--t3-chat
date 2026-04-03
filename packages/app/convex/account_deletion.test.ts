import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex } from "./setup.test.ts";
import { workspaces_db_create, workspaces_db_ensure_default_workspace_and_project_for_user } from "../server/workspaces.ts";
import { user_limits } from "../shared/limits.ts";

async function account_deletion_test_bootstrap_user(
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

async function account_deletion_test_seed_page(
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

describe("record_clerk_user_deleted_webhook", () => {
	test("dedupes repeated deliveries by receipt id", async () => {
		const t = test_convex();
		await t.run((ctx) =>
			account_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-dedupe",
				displayName: "Delete Me",
			}),
		);

		const first = await t.run((ctx) =>
			ctx.runMutation(internal.account_deletion.record_clerk_user_deleted_webhook, {
				eventId: "evt_delete_1",
				eventType: "user.deleted",
				clerkUserId: "clerk-user-delete-dedupe",
				receivedAt: 1000,
			}),
		);
		const second = await t.run((ctx) =>
			ctx.runMutation(internal.account_deletion.record_clerk_user_deleted_webhook, {
				eventId: "evt_delete_1",
				eventType: "user.deleted",
				clerkUserId: "clerk-user-delete-dedupe",
				receivedAt: 1001,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [receipts, requests] = await Promise.all([
				ctx.db.query("clerk_webhook_receipts").collect(),
				ctx.db.query("user_deletion_requests").collect(),
			]);

			return {
				receipts,
				requests,
			};
		});

		expect(first.alreadyReceived).toBe(false);
		expect(first.requestQueued).toBe(false);
		expect(second.alreadyReceived).toBe(true);
		expect(second.requestQueued).toBe(false);
		expect(after.receipts).toHaveLength(1);
		expect(after.requests).toHaveLength(0);
	});

	test("requeues an existing failed local deletion request in safety-net mode", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			account_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-requeue",
				displayName: "Delete Requeue User",
			}),
		);

		const request = await t.run((ctx) =>
			ctx.runMutation(internal.account_deletion.enqueue_user_deletion_request, {
				clerkUserId: "clerk-user-delete-requeue",
				userId: seeded.userId,
				nowTs: 1000,
			}),
		);
		await t.run((ctx) =>
			ctx.runMutation(internal.account_deletion.mark_user_deletion_request_failed, {
				requestId: request.requestId,
				errorMessage: "Failed to delete account",
				nowTs: 1001,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.account_deletion.record_clerk_user_deleted_webhook, {
				eventId: "evt_delete_requeue",
				eventType: "user.deleted",
				clerkUserId: "clerk-user-delete-requeue",
				receivedAt: 1002,
			}),
		);

		const after = await t.run((ctx) => ctx.db.get("user_deletion_requests", request.requestId));

		expect(result.alreadyReceived).toBe(false);
		expect(result.requestQueued).toBe(true);
		expect(after?.status).toBe("queued");
		expect(after?.userId).toBe(seeded.userId);
	});
});

describe("process_user_deletion_requests", () => {
	test("tombstones the user, preserves shared content, and cleans orphaned personal workspaces", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			account_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-main",
				displayName: "Deleted User",
				avatarUrl: "https://example.com/avatar.png",
			}),
		);
		const collaborator = await t.run((ctx) =>
			account_deletion_test_bootstrap_user(ctx, {
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
			});

			await ctx.db.insert("pages_pending_edits", {
				workspaceId: String(created._yay.workspaceId),
				projectId: String(created._yay.defaultProjectId),
				userId: String(deletedUser.userId),
				pageId: (
					await account_deletion_test_seed_page(ctx, {
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
				pageId: (
					await ctx.db
						.query("pages")
						.withIndex("by_workspaceId_projectId_name", (q) =>
							q.eq("workspaceId", String(created._yay.workspaceId)).eq("projectId", String(created._yay.defaultProjectId)).eq("name", "shared-page"),
						)
						.first()
						.then((page) => {
							if (!page) {
								throw new Error("shared page not found");
							}

							return page._id;
						})
				),
				lastSequenceSaved: 0,
				updatedAt: Date.now(),
			});

			return created._yay;
		});

		await t.run((ctx) =>
			account_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(deletedUser.defaultWorkspaceId),
				projectId: String(deletedUser.defaultProjectId),
				tag: "personal-page",
			}),
		);

		const enqueueResult = await t.run((ctx) =>
			ctx.runMutation(internal.account_deletion.enqueue_user_deletion_request, {
				clerkUserId: "clerk-user-delete-main",
				userId: deletedUser.userId,
				nowTs: 10_000,
			}),
		);

		await t.run((ctx) =>
			ctx.runMutation(internal.account_deletion.process_user_deletion_request, {
				requestId: enqueueResult.requestId,
				nowTs: 20_000,
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
				orphanRequests,
				personalWorkspace,
				personalProject,
				sharedWorkspaceDoc,
				sharedPages,
			] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_userId_workspaceId_projectId", (q) => q.eq("userId", deletedUser.userId))
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
				ctx.db.query("workspaces_data_deletion_requests").collect(),
				ctx.db.query("workspace_orphan_cleanup_requests").collect(),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db.get("workspaces", sharedWorkspace.workspaceId),
				ctx.db
					.query("pages")
					.withIndex("by_workspaceId_projectId_name", (q) =>
						q.eq("workspaceId", String(sharedWorkspace.workspaceId))
							.eq("projectId", String(sharedWorkspace.defaultProjectId))
							.eq("name", "shared-page"),
					)
					.collect(),
			]);

			return {
				user,
				anagraphic,
				memberships,
				pendingEdits,
				pendingEditSaves,
				cleanupTasks,
				purgeRequests: purgeRequests.filter((row) => row.workspaceId === deletedUser.defaultWorkspaceId),
				orphanRequests,
				personalWorkspace,
				personalProject,
				sharedWorkspaceDoc,
				sharedPages,
			};
		});

		expect(afterUserDeletion.user?.deletedAt).toBe(20_000);
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
		expect(afterUserDeletion.sharedWorkspaceDoc?._id).toBe(sharedWorkspace.workspaceId);
		expect(afterUserDeletion.purgeRequests).toHaveLength(1);
		expect(afterUserDeletion.purgeRequests[0]?.scope).toBe("user");
		expect(afterUserDeletion.orphanRequests).toHaveLength(0);
		expect(afterUserDeletion.sharedPages).toHaveLength(1);

		const newestPurgeRequestCreationTime = Math.max(...afterUserDeletion.purgeRequests.map((row) => row._creationTime));
		await t.run((ctx) =>
			ctx.runMutation(internal.workspaces.purge_data_deletion_requests, {
				_test_now: newestPurgeRequestCreationTime + 7 * 24 * 60 * 60 * 1000 + 1,
			}),
		);

		const purgeRequestsAfter = await t.run(async (ctx) => ctx.db.query("workspaces_data_deletion_requests").collect());
		expect(purgeRequestsAfter).toHaveLength(0);
	});
});

describe("resolve_user after tombstone", () => {
	test("creates a fresh user row for a future sign-up", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			account_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return",
				displayName: "Returning User",
			}),
		);

		const enqueueResult = await t.run((ctx) =>
			ctx.runMutation(internal.account_deletion.enqueue_user_deletion_request, {
				clerkUserId: "clerk-user-delete-return",
				userId: deletedUser.userId,
				nowTs: 30_000,
			}),
		);
		await t.run((ctx) =>
			ctx.runMutation(internal.account_deletion.process_user_deletion_request, {
				requestId: enqueueResult.requestId,
				nowTs: 30_001,
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
