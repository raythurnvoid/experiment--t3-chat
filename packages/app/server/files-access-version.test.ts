import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_access_version_db_get, files_access_version_db_wrap } from "./files-access-version.ts";
import {
	channels_notifications_db_ensure_summary,
	channels_notifications_db_get_authority_pins,
} from "./channels-notifications.ts";
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

function insert_file_channel(
	ctx: MutationCtx,
	scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
	fileNodeId: Id<"files_nodes">,
) {
	return ctx.db.insert("channels", {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		createdBy: scope.userId,
		createdAt: 1,
		kind: "file",
		fileNodeId,
	});
}

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
			await writes.db.patch("access_control_permission_grants", grantId, { permission: "content.write" });
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

describe("Messages authority capture", () => {
	test("queues a deleted file's comment channel without exposing names, archive or content edits", async () => {
		const t = test_convex();
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const { nodeId, channelId } = await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			const id = await writes.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				kind: "file",
				textKind: "rich_text",
				createdBy: scope.userId,
				updatedBy: scope.userId,
			});
			await writes.flush();
			return { nodeId: id, channelId: await insert_file_channel(ctx, scope, id) };
		});
		const pins = () => t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, scope));
		const jobs = () => t.run((ctx) => ctx.db.query("channels_access_jobs").collect());
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
		expect({ pins: await pins(), jobs: await jobs() }, "hidden content and labels leave Messages alone").toEqual({
			pins: before,
			jobs: [],
		});
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.delete("files_nodes", nodeId);
			await writes.flush();
		});
		expect(await pins(), "a file change leaves the other members' totals alone").toEqual(before);
		expect(await jobs()).toMatchObject([{ channelId, requestedRevision: 1, phase: "members" }]);
	});

	test("resets the workspace for a folder that Trash items can point at, not for a plain folder", async () => {
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
		const pins = () => t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, scope));
		const patch = (fields: { restrictedScopeNodeId: typeof nodeId | null; parentScopeNodeId?: null }) =>
			t.run(async (ctx) => {
				const writes = files_access_version_db_wrap(ctx);
				await writes.db.patch("files_nodes", nodeId, fields);
				await writes.flush();
			});
		const before = await pins();
		await patch({ restrictedScopeNodeId: nodeId, parentScopeNodeId: null });
		expect(await pins(), "no Trash item can point at a folder that was never restricted").toEqual(before);
		await patch({ restrictedScopeNodeId: null });
		expect(
			(await pins()).workspaceAuthorityPin?.revision,
			"Trash items that point at the opened folder read access through it",
		).toBe((before.workspaceAuthorityPin?.revision ?? 0) + 1);
	});

	test("captures only the selected Move place and ignores physical cleanup", async () => {
		const f = await test_create_saved_placement_fixture();
		const record = (await f.t.run((ctx) => ctx.db.get("files_move_cohort_nodes", f.recordId)))!;
		const channelId = await f.t.run((ctx) => insert_file_channel(ctx, f.db, f.nodeId));
		const pins = () => f.t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, f.db));
		const jobs = () => f.t.run((ctx) => ctx.db.query("channels_access_jobs").collect());
		const before = await pins();
		await f.t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("files_saved_places", record.afterPlaceId!, { restrictedScopeNodeId: f.nodeId });
			await writes.db.patch("files_nodes", f.nodeId, { restrictedScopeNodeId: f.nodeId });
			await writes.flush();
		});
		expect(
			{ pins: await pins(), jobs: await jobs() },
			"unselected and held physical changes do not reveal private work",
		).toEqual({
			pins: before,
			jobs: [],
		});
		await f.t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("files_saved_places", record.beforePlaceId!, { restrictedScopeNodeId: f.nodeId });
			await writes.flush();
		});
		expect(await pins(), "a file change leaves the other members' totals alone").toEqual(before);
		const queued = await jobs();
		expect(queued).toMatchObject([{ channelId, requestedRevision: 1 }]);
		await f.t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("files_nodes", f.nodeId, { moveCohortId: undefined });
			await writes.db.delete("files_saved_places", record.beforePlaceId!);
			await writes.db.delete("files_saved_places", record.afterPlaceId!);
			await writes.flush();
		});
		expect({ pins: await pins(), jobs: await jobs() }, "cleanup does not queue Messages work again").toEqual({
			pins: before,
			jobs: queued,
		});
	});

	test("the public Restrict door queues a held file's comment channel at once", async () => {
		const f = await test_create_saved_placement_fixture();
		const channelId = await f.t.run((ctx) => insert_file_channel(ctx, f.db, f.nodeId));
		const before = await f.t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, f.db));
		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, f.db))).toEqual(before);
		expect(await f.t.run((ctx) => ctx.db.query("channels_access_jobs").collect())).toMatchObject([{ channelId }]);
	});

	test("a read share reaches only the file, the person or the workspace it names", async () => {
		const t = test_convex();
		// Use the default workspace. An organization role is stored there too, and a share must not be
		// taken for one.
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { workspaceName: "home" }));
		const f = await t.run(async (ctx) => {
			const node = {
				...test_mocks.files.base(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
			};
			const folderId = await ctx.db.insert("files_nodes", node);
			const fileId = await ctx.db.insert("files_nodes", { ...node, kind: "file", textKind: "rich_text" });
			const membership = (await ctx.db.get("organizations_workspaces_users", scope.membershipId))!;
			return {
				folderId,
				fileId,
				channelId: await insert_file_channel(ctx, scope, fileId),
				summaryId: (await channels_notifications_db_ensure_summary(ctx, membership))._id,
			};
		});
		const share = (
			grant: { resourceId: Id<"files_nodes"> } & (
				| { principalKind: "user"; userId: Id<"users"> }
				| { principalKind: "role"; role: "member" }
			),
		) =>
			t.run(async (ctx) => {
				const writes = files_access_version_db_wrap(ctx);
				await writes.db.insert("access_control_permission_grants", {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					resourceKind: "file",
					permission: "content.read",
					createdAt: 1,
					updatedAt: 1,
					...grant,
				});
				await writes.flush();
			});
		const state = () =>
			t.run(async (ctx) => ({
				pins: await channels_notifications_db_get_authority_pins(ctx.db, scope),
				accessJobs: (await ctx.db.query("channels_access_jobs").collect()).map((job) => job.channelId),
				memberJobs: await ctx.db.query("channels_member_authority_jobs").collect(),
				memberRepairs: (await ctx.db.get("channels_summaries", f.summaryId))!.authorityRevision,
			}));
		const before = await state();

		await share({ resourceId: f.fileId, principalKind: "user", userId: scope.userId });
		expect(await state(), "a share on a file rechecks only that file's comment channel").toEqual({
			...before,
			accessJobs: [f.channelId],
		});

		await share({ resourceId: f.folderId, principalKind: "user", userId: scope.userId });
		expect(await state(), "a folder share with one person repairs that person in this workspace only").toEqual({
			...before,
			accessJobs: [f.channelId],
			memberRepairs: before.memberRepairs + 1,
		});

		await share({ resourceId: f.folderId, principalKind: "role", role: "member" });
		expect(
			(await state()).pins.workspaceAuthorityPin?.revision,
			"a folder share with a role resets the workspace totals",
		).toBe((before.pins.workspaceAuthorityPin?.revision ?? 0) + 1);
	});

	test("past the limit of one mutation, a further change resets its own workspace totals", async () => {
		const t = test_convex();
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const f = await t.run(async (ctx) => {
			const otherWorkspaceId = (await ctx.db.get("organizations", scope.organizationId))!.defaultWorkspaceId!;
			const insert_file = (workspaceId: Id<"organizations_workspaces">) =>
				ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: scope.organizationId,
					workspaceId,
					kind: "file",
					textKind: "rich_text",
					createdBy: scope.userId,
					updatedBy: scope.userId,
				});
			// 100 files in one workspace fill the limit. One more file in another workspace passes it.
			const nodeIds = [];
			for (let index = 0; index < 100; index += 1) nodeIds.push(await insert_file(scope.workspaceId));
			nodeIds.push(await insert_file(otherWorkspaceId));
			return { otherWorkspaceId, nodeIds, channelId: await insert_file_channel(ctx, scope, nodeIds[0]!) };
		});
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			for (const nodeId of f.nodeIds) await writes.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
			await writes.flush();
		});
		const result = await t.run(async (ctx) => ({
			firstPin: (await channels_notifications_db_get_authority_pins(ctx.db, scope)).workspaceAuthorityPin,
			otherPin: (
				await channels_notifications_db_get_authority_pins(ctx.db, { ...scope, workspaceId: f.otherWorkspaceId })
			).workspaceAuthorityPin?.revision,
			accessJobs: (await ctx.db.query("channels_access_jobs").collect()).map((job) => job.channelId),
		}));
		expect(result, "files under the limit keep their own recheck, and the file past it resets its workspace").toEqual({
			firstPin: null,
			otherPin: 1,
			accessJobs: [f.channelId],
		});
	});

	test("member changes leave shared totals alone and tenant deletion never creates authority", async () => {
		const t = test_convex();
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const noPins = { organizationAuthorityPin: null, workspaceAuthorityPin: null };
		const summaryId = await t.run(async (ctx) => {
			const membership = (await ctx.db.get("organizations_workspaces_users", scope.membershipId))!;
			return (await channels_notifications_db_ensure_summary(ctx, membership))._id;
		});
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.patch("organizations_workspaces_users", scope.membershipId, { active: false });
			await writes.db.patch("organizations_workspaces_users", scope.membershipId, { active: true });
			await writes.flush();
		});
		expect(
			await t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, scope)),
			"a returning member repairs only their own totals",
		).toEqual(noPins);
		expect(
			(await t.run((ctx) => ctx.db.get("channels_summaries", summaryId)))?.authorityRevision,
			"a returning member is counted again",
		).toBe(1);
		await t.run(async (ctx) => {
			const writes = files_access_version_db_wrap(ctx);
			await writes.db.delete("organizations_workspaces_users", scope.membershipId);
			await writes.db.delete("organizations_workspaces", scope.workspaceId);
			await writes.flush();
		});
		expect(await t.run((ctx) => channels_notifications_db_get_authority_pins(ctx.db, scope))).toEqual(noPins);
		expect(await t.run((ctx) => ctx.db.query("channels_authority_jobs").collect())).toEqual([]);
	});
});
