import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_access_version_db_get, files_access_version_db_wrap } from "./files-access-version.ts";
import { channels_notifications_db_get_authority_pins } from "./channels-notifications.ts";
import { test_create_saved_placement_fixture } from "./files-saved-placement.test-fixtures.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("messages-authority-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

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
		const messageBefore = await t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, scope));
		expect(before[1]?.revision).toBe(1);
		expect(messageBefore.workspaceAuthorityPin?.revision).toBe(1);
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("access_control_permission_grants", grantId, { updatedAt: 2 });
			await writes.flush();
		});
		expect(await t.run((ctx) => files_access_version_db_get(ctx.db, scope))).toEqual(before);
		expect(await t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, scope))).toEqual(messageBefore);
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("access_control_permission_grants", grantId, { externalPluginMembershipLifetime: 2 });
			await writes.flush();
		});
		const after = await t.run((ctx) => files_access_version_db_get(ctx.db, scope));
		expect(after[1]?.revision).toBe(2);
		expect((await t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, scope))).workspaceAuthorityPin?.revision).toBe(2);
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

describe("Messages authority capture", () => {
	test("captures kind and deletion without exposing names, archive or content edits", async () => {
		const t = test_convex();
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const nodeId = await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			const id = await writes.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
			});
			await writes.flush();
			return id;
		});
		const pins = () => t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, scope));
		const before = await pins();
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("files_nodes", nodeId, {
				name: "private rename",
				archiveOperationId: nodeId,
				contentByteSize: 17,
				updatedAt: 2,
			});
			await writes.flush();
		});
		expect(await pins(), "hidden content and labels leave Messages authority alone").toEqual(before);
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("files_nodes", nodeId, { kind: "file" });
			await writes.flush();
		});
		const changed = await pins();
		expect(changed.workspaceAuthorityPin?.revision, "kind-only changes pass the old Files fast path").toBe((before.workspaceAuthorityPin?.revision ?? 0) + 1);
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.delete("files_nodes", nodeId);
			await writes.flush();
		});
		expect((await pins()).workspaceAuthorityPin?.revision).toBe(changed.workspaceAuthorityPin!.revision + 1);
	});

	test("captures only the selected Move place and ignores physical cleanup", async () => {
		const f = await test_create_saved_placement_fixture();
		const record = (await f.t.run((ctx) => ctx.db.get("files_move_cohort_nodes", f.recordId)))!;
		const pins = () => f.t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, f.db));
		const before = await pins();
		await f.t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("files_saved_places", record.afterPlaceId!, { restrictedScopeNodeId: f.nodeId });
			await writes.db.patch("files_nodes", f.nodeId, { restrictedScopeNodeId: f.nodeId });
			await writes.flush();
		});
		expect(await pins(), "unselected and held physical changes do not reveal private work").toEqual(before);
		await f.t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("files_saved_places", record.beforePlaceId!, { restrictedScopeNodeId: f.nodeId });
			await writes.flush();
		});
		const changed = await pins();
		expect(changed.workspaceAuthorityPin?.revision).toBe((before.workspaceAuthorityPin?.revision ?? 0) + 1);
		await f.t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("files_nodes", f.nodeId, { moveCohortId: undefined });
			await writes.db.delete("files_saved_places", record.beforePlaceId!);
			await writes.db.delete("files_saved_places", record.afterPlaceId!);
			await writes.flush();
		});
		expect(await pins(), "cleanup does not advance Messages authority again").toEqual(changed);
	});

	test("the public Restrict door invalidates a held file immediately", async () => {
		const f = await test_create_saved_placement_fixture();
		const before = await f.t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, f.db));
		expect(await f.asUser.mutation(api.files_sharing.restrict_node, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
		})).toEqual({ _yay: null });
		const after = await f.t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, f.db));
		expect(after.workspaceAuthorityPin?.revision).toBe((before.workspaceAuthorityPin?.revision ?? 0) + 1);
	});

	test("coalesces member changes and never recreates authority after tenant deletion", async () => {
		const t = test_convex();
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("organizations_workspaces_users", scope.membershipId, { active: false });
			await writes.db.patch("organizations_workspaces_users", scope.membershipId, { active: true });
			await writes.flush();
		});
		expect((await t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, scope))).workspaceAuthorityPin?.revision).toBe(1);
		await t.run(async (ctx) => {
			await ctx.db.delete("channels_authority_versions", (await ctx.db.query("channels_authority_versions").first())!._id);
			for (const job of await ctx.db.query("channels_authority_jobs").collect())
				await ctx.db.delete("channels_authority_jobs", job._id);
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.delete("organizations_workspaces_users", scope.membershipId);
			await writes.db.delete("organizations_workspaces", scope.workspaceId);
			await writes.flush();
		});
		expect(await t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, scope))).toEqual({ organizationAuthorityPin: null, workspaceAuthorityPin: null });
		expect(await t.run((ctx) => ctx.db.query("channels_authority_jobs").collect())).toEqual([]);
	});
});
