import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import type { MutationCtx } from "../convex/_generated/server.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_access_version_db_wrap } from "./files-access-version.ts";
import { plugins_file_grants_db_get_authority_pins } from "./plugins-file-grants.ts";
import { test_create_saved_placement_fixture } from "./files-saved-placement.test-fixtures.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("plugin-authority-test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const write = (fn: (ctx: MutationCtx) => Promise<unknown>) =>
		t.run(async (ctx) => {
			const capture = files_access_version_db_wrap(ctx);
			await fn({ ...ctx, db: capture.db });
			await capture.flush();
		});
	const pins = () => t.run((ctx) => plugins_file_grants_db_get_authority_pins(ctx.db, scope));
	return { t, scope, write, pins };
}

describe("personal plugin authority capture", () => {
	test.each(["content.read", "content.write", "content.permissions.manage"] as const)(
		"captures human %s without an external subscriber",
		async (permission) => {
			const f = await fixture();
			const before = await f.pins();
			await f.write((ctx) =>
				ctx.db.insert("access_control_permission_grants", {
					organizationId: f.scope.organizationId,
					workspaceId: f.scope.workspaceId,
					userId: f.scope.userId,
					resourceKind: "workspace",
					resourceId: f.scope.workspaceId,
					principalKind: "user",
					permission,
					createdAt: 1,
					updatedAt: 1,
				}),
			);
			expect((await f.pins()).workspaceAuthorityPin?.revision, "the human change queues a plugin pass").toBe(
				(before.workspaceAuthorityPin?.revision ?? 0) + 1,
			);
			const job = await f.t.run((ctx) =>
				ctx.db
					.query("plugins_file_grant_jobs")
					.withIndex("by_organization_workspace", (q) =>
						q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId),
					)
					.first(),
			);
			expect(job?.scheduledId, "a local worker is scheduled without a feed lease").toBeTruthy();
		},
	);

	test("ignores account grants and unrelated human fields", async () => {
		const f = await fixture();
		const before = await f.pins();
		await f.write(async (ctx) => {
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				resourceKind: "workspace",
				resourceId: f.scope.workspaceId,
				principalKind: "service_account",
				permission: "content.read",
				createdAt: 1,
				updatedAt: 1,
			});
			await ctx.db.patch("organizations_workspaces_users", f.scope.membershipId, { displayName: "New name" });
		});
		expect(await f.pins(), "account authority and labels do not change personal grants").toEqual(before);
	});

	test("captures roles", async () => {
		const f = await fixture();
		const before = await f.pins();
		await f.write(async (ctx) => {
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				userId: f.scope.userId,
				role: "viewer",
				createdAt: 1,
				updatedAt: 1,
			});
			const roleId = await ctx.db.insert("access_control_roles", {
				organizationId: f.scope.organizationId,
				name: "Custom",
				normalizedName: "custom",
				description: "",
				permissions: ["content.read"],
				createdBy: f.scope.userId,
				createdAt: 1,
				updatedAt: 1,
			});
			await ctx.db.patch("access_control_roles", roleId, { permissions: ["content.read", "content.write"] });
		});
		const roles = await f.pins();
		expect(roles.organizationAuthorityPin?.revision, "role changes use the organization source").toBe(
			(before.organizationAuthorityPin?.revision ?? 0) + 1,
		);
	});

	test("captures owner changes", async () => {
		const f = await fixture();
		const before = await f.pins();
		await f.write(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "new-owner" });
			await ctx.db.patch("organizations", f.scope.organizationId, { ownerUserId: userId });
		});
		expect((await f.pins()).organizationAuthorityPin?.revision, "owner transfer queues all personal grants").toBe(
			(before.organizationAuthorityPin?.revision ?? 0) + 1,
		);
	});

	test("captures membership removal", async () => {
		const f = await fixture();
		const before = await f.pins();
		await f.write((ctx) =>
			ctx.db.patch("organizations_workspaces_users", f.scope.membershipId, { pendingOrganizationRemoval: true }),
		);
		expect((await f.pins()).workspaceAuthorityPin?.revision, "pending membership removal queues the workspace").toBe(
			(before.workspaceAuthorityPin?.revision ?? 0) + 1,
		);
	});

	test("captures restriction, Add people, Trash and Restore", async () => {
		const f = await fixture();
		const nodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				createdBy: f.scope.userId,
				updatedBy: f.scope.userId,
			}),
		);
		const patches = [
			{ restrictedScopeNodeId: nodeId, isRestrictedScopeRoot: true },
			{ extendedScopeNodeId: nodeId, parentExtendedScopeNodeId: null },
			{ archiveOperationId: nodeId },
			{ archiveOperationId: null },
		];
		for (const patch of patches) {
			const before = await f.pins();
			await f.write((ctx) => ctx.db.patch("files_nodes", nodeId, patch));
			expect
				.soft((await f.pins()).workspaceAuthorityPin?.revision, `file change queues a pass: ${JSON.stringify(patch)}`)
				.toBe((before.workspaceAuthorityPin?.revision ?? 0) + 1);
		}
	});

	test("captures the selected Move view and publication, but not staging or cleanup", async () => {
		const f = await test_create_saved_placement_fixture();
		const record = (await f.t.run((ctx) => ctx.db.get("files_move_cohort_nodes", f.recordId)))!;
		const pins = () => f.t.run((ctx) => plugins_file_grants_db_get_authority_pins(ctx.db, f.db));
		const write = (fn: (ctx: MutationCtx) => Promise<unknown>) =>
			f.t.run(async (ctx) => {
				const capture = files_access_version_db_wrap(ctx);
				await fn({ ...ctx, db: capture.db });
				await capture.flush();
			});
		const before = await pins();
		await write(async (ctx) => {
			await ctx.db.patch("files_saved_places", record.afterPlaceId!, { restrictedScopeNodeId: f.nodeId });
			await ctx.db.patch("files_nodes", f.nodeId, { restrictedScopeNodeId: f.nodeId });
		});
		expect(await pins(), "unpublished changes do not change applied access").toEqual(before);
		await write((ctx) => ctx.db.patch("files_saved_places", record.beforePlaceId!, { archiveOperationId: f.nodeId }));
		const selected = await pins();
		expect(selected.workspaceAuthorityPin?.revision, "selected Trash change queues a pass").toBe(
			(before.workspaceAuthorityPin?.revision ?? 0) + 1,
		);
		await write((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { visibleView: "after" }));
		const published = await pins();
		expect(published.workspaceAuthorityPin?.revision, "Move publication queues a pass").toBe(
			selected.workspaceAuthorityPin!.revision + 1,
		);
		await write(async (ctx) => {
			await ctx.db.patch("files_nodes", f.nodeId, { moveCohortId: undefined });
			await ctx.db.delete("files_saved_places", record.beforePlaceId!);
			await ctx.db.delete("files_saved_places", record.afterPlaceId!);
		});
		expect(await pins(), "physical cleanup does not request another pass").toEqual(published);
	});

	test("does not create clocks or jobs after tenant deletion", async () => {
		const f = await fixture();
		await f.write(async (ctx) => {
			await ctx.db.delete("organizations_workspaces_users", f.scope.membershipId);
			await ctx.db.delete("organizations_workspaces", f.scope.workspaceId);
		});
		expect(await f.pins(), "a deleted tenant keeps no new plugin source clocks").toEqual({
			organizationAuthorityPin: null,
			workspaceAuthorityPin: null,
		});
		expect(await f.t.run((ctx) => ctx.db.query("plugins_file_grant_jobs").collect())).toEqual([]);
	});
});
