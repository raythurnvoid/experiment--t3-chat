import { describe, expect, test } from "vitest";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_access_version_db_get, files_access_version_db_wrap } from "./files-access-version.ts";

describe("Files access versions", () => {
	test("versions human read grants and ignores unrelated grant fields", async () => {
		const t = test_convex();
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const grantId = await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			const id = await writes.db.insert("access_control_permission_grants", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				resourceKind: "workspace",
				resourceId: scope.workspaceId,
				principalKind: "user",
				userId: scope.userId,
				permission: "content.read",
				createdAt: 1,
				updatedAt: 1,
			});
			await writes.flush();
			return id;
		});
		const before = await t.run((ctx) => files_access_version_db_get(ctx.db, scope));
		expect(before[1]?.revision).toBe(1);
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("access_control_permission_grants", grantId, { updatedAt: 2 });
			await writes.flush();
		});
		expect(await t.run((ctx) => files_access_version_db_get(ctx.db, scope))).toEqual(before);
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("access_control_permission_grants", grantId, { externalPluginMembershipLifetime: 2 });
			await writes.flush();
		});
		const after = await t.run((ctx) => files_access_version_db_get(ctx.db, scope));
		expect(after[1]?.revision).toBe(2);
	});

	test("versions scope pointers, roles and membership lifetimes", async () => {
		const t = test_convex();
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			const nodeId = await writes.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
			});
			await writes.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
			await writes.db.insert("access_control_role_assignments", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: scope.userId,
				role: "viewer",
				createdAt: 1,
				updatedAt: 1,
			});
			await writes.db.insert("organizations_membership_lifetimes", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: scope.userId,
				membershipId: scope.membershipId,
				lifetime: 1,
				active: true,
			});
			await writes.flush();
		});
		const pins = await t.run((ctx) => files_access_version_db_get(ctx.db, scope));
		expect(pins.map((pin) => pin?.revision)).toEqual([1, 1]);
	});

	test("a change of extendedScopeNodeId moves the clock", async () => {
		const t = test_convex();
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const nodeId = await t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
			}),
		);
		const patch = (fields: { name?: string; extendedScopeNodeId?: typeof nodeId }) =>
			t.run(async (ctx) => {
				const writes = files_access_version_db_wrap(ctx);
				await writes.db.patch("files_nodes", nodeId, fields);
				await writes.flush();
			});
		const before = await t.run((ctx) => files_access_version_db_get(ctx.db, scope));
		await patch({ name: "renamed" });
		expect(await t.run((ctx) => files_access_version_db_get(ctx.db, scope))).toEqual(before);
		await patch({ extendedScopeNodeId: nodeId });
		const after = await t.run((ctx) => files_access_version_db_get(ctx.db, scope));
		expect(after[1]?.revision).toBe((before[1]?.revision ?? 0) + 1);
	});

	test("does not recreate a tenant clock after deletion", async () => {
		const t = test_convex();
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => {
			await ctx.db.insert("files_access_versions", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				revision: 3,
			});
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.delete("organizations_workspaces_users", scope.membershipId);
			await writes.db.delete("organizations_workspaces", scope.workspaceId);
			await writes.flush();
		});
		expect(await t.run((ctx) => files_access_version_db_get(ctx.db, scope))).toEqual([null, null]);
	});
});
