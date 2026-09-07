import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	test_convex,
	test_mocks_cancel_pending_home_file_seeds,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { access_control_FILE_SHARE_LEVELS } from "../shared/access-control.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("tenant deletion with many direct file grants", () => {
	for (const scope of ["workspace", "organization"] as const) {
		test(`delete_${scope} accepts a tenant with 16,200 valid file grants`, async () => {
			vi.useFakeTimers();
			const t = test_convex({ transactionLimits: true });
			const fixture = await t.run(async (ctx) => {
				const ownerId = await ctx.db.insert("users", { clerkUserId: `review-${scope}-owner` });
				const membership = await test_mocks_fill_db_with.membership(ctx, {
					userId: ownerId,
					organizationName: `review-${scope}`,
					workspaceName: "shared",
					plan: null,
				});
				const memberId = await ctx.db.insert("users", { clerkUserId: `review-${scope}-member` });
				const personalMembership = await test_mocks_fill_db_with.membership(ctx, {
					userId: memberId,
					organizationName: "personal",
					workspaceName: "home",
					plan: null,
				});
				await test_mocks_cancel_pending_home_file_seeds(ctx);
				return { ...membership, memberId, personalMembership };
			});
			const owner = t.withIdentity({
				issuer: "https://clerk.test",
				external_id: fixture.userId,
			});
			expect(
				await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userIdToAdd: fixture.memberId,
				}),
			).toEqual({ _yay: null });

			// Each folder has one direct member share. The 50-file role cap does not apply.
			// Seed in small transactions, with the same three docs as a real Can manage share.
			for (let start = 0; start < 5400; start += 100) {
				await t.run(async (ctx) => {
					for (let index = start; index < start + 100; index += 1) {
						const name = `shared-${index}`;
						const nodeId = await ctx.db.insert("files_nodes", {
							organizationId: fixture.organizationId,
							workspaceId: fixture.workspaceId,
							parentId: "root",
							name,
							path: `/${name}`,
							treePath: `/${name}/`,
							pathDepth: 1,
							kind: "folder",
							lowercaseExtension: null,
							createdBy: fixture.userId,
							updatedBy: fixture.userId,
							updatedAt: Date.now(),
						});
						await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
						for (const permission of access_control_FILE_SHARE_LEVELS.manage.permissions) {
							await ctx.db.insert("access_control_permission_grants", {
								organizationId: fixture.organizationId,
								workspaceId: fixture.workspaceId,
								resourceKind: "file",
								resourceId: String(nodeId),
								principalKind: "user",
								userId: fixture.memberId,
								permission,
								createdAt: Date.now(),
								updatedAt: Date.now(),
							});
						}
					}
				});
			}
			const { grantCount, firstGrant } = await t.run(async (ctx) => {
				const grants = await ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_organization_user_workspace_resource_permission", (q) =>
						q.eq("organizationId", fixture.organizationId).eq("userId", fixture.memberId),
					)
					.collect();
				return { grantCount: grants.length, firstGrant: grants[0]! };
			});
			expect(grantCount).toBe(16_200);

			// The public sharing door accepts this exact seeded shape.
			const nodeId = await t.run(async (ctx) => ctx.db.normalizeId("files_nodes", firstGrant.resourceId));
			if (!nodeId) throw new Error("Expected a real shared folder");
			expect(
				await owner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: fixture.membershipId,
					nodeId,
					principal: { kind: "user", userId: fixture.memberId },
					level: "manage",
				}),
			).toEqual({ _yay: null });

			const member = t.withIdentity({ issuer: "https://clerk.test", external_id: fixture.memberId });
			const membership = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", fixture.workspaceId).eq("userId", fixture.memberId),
					)
					.unique(),
			);
			const shareArgs = { membershipId: membership!._id, nodeId };
			expect(await member.query(api.files_sharing.get_node_share_state, shareArgs)).toMatchObject({ canManage: true });

			// Phase 1 must fit in one real Convex transaction.
			await expect(
				scope === "workspace"
					? owner.mutation(api.organizations.delete_workspace, { workspaceId: fixture.workspaceId })
					: owner.mutation(api.organizations.delete_organization, { organizationId: fixture.organizationId }),
			).resolves.toEqual({ _yay: null });
			expect(await t.run((ctx) => ctx.db.get("access_control_permission_grants", firstGrant._id))).not.toBeNull();
			expect(await member.query(api.files_sharing.get_node_share_state, shareArgs)).toBeNull();
			expect(
				await member.mutation(api.files_sharing.set_node_share_grant, {
					...shareArgs,
					principal: { kind: "user", userId: fixture.memberId },
					level: "manage",
				}),
			).toMatchObject({ _nay: { message: "Unauthorized" } });

			const requests = await t.run((ctx) => ctx.db.query("data_deletion_requests").collect());
			const request = requests.find((doc) => doc.scope === scope && doc.organizationId === fixture.organizationId)!;
			const processRequest =
				scope === "workspace"
					? internal.data_deletion.process_workspace_deletion_request
					: internal.data_deletion.process_organization_deletion_request;
			vi.setSystemTime(request.eligibleAt + 1);
			let done = false;
			for (let pass = 0; pass < 500 && !done; pass += 1) {
				const result = await t.mutation(processRequest, { requestId: request._id, _test_batchSize: 100 });
				expect(result.deletedCount).toBeLessThanOrEqual(100);
				done = result.done;
			}
			expect(done).toBe(true);
			expect(await t.run((ctx) => ctx.db.get("data_deletion_requests", request._id))).toBeNull();
			expect(
				await t.run((ctx) =>
					ctx.db
						.query("access_control_permission_grants")
						.withIndex("by_organization_workspace_resource_user_permission", (q) =>
							q.eq("organizationId", fixture.organizationId).eq("workspaceId", fixture.workspaceId),
						)
						.first(),
				),
			).toBeNull();
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toBeNull();
			expect(await t.mutation(processRequest, { requestId: request._id, _test_batchSize: 100 })).toEqual({
				done: true,
				deletedCount: 0,
			});
			expect(
				await member.query(api.organizations.get_membership_for_scope, {
					organizationId: fixture.personalMembership.organizationId,
					workspaceId: fixture.personalMembership.workspaceId,
				}),
			).toMatchObject({ _id: fixture.personalMembership.membershipId, active: true });
		}, 120_000);
	}
});
