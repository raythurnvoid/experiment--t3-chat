import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function create_transfer_activity() {
	const t = test_convex();
	const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const member = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "clipboard-member" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId,
			active: true,
			updatedAt: Date.now(),
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId,
			role: "member",
			now: Date.now(),
		});
		return { userId, membershipId };
	});
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
	const source = await asOwner.mutation(api.files_nodes.create_folder_node, {
		membershipId: owner.membershipId,
		parentId: files_ROOT_ID,
		path: "source",
	});
	if (source._nay) throw new Error(source._nay.message);
	const started = await asMember.mutation(api.files_transfer.start, {
		membershipId: member.membershipId,
		requestId: "copy-activity",
		sourceIds: [source._yay.nodeId],
		kind: "copy",
		targetParentId: files_ROOT_ID,
	});
	if (started._nay) throw new Error(started._nay.message);
	const activity = await t.run((ctx) =>
		ctx.db
			.query("activities")
			.withIndex("by_source_id", (q) => q.eq("source.id", started._yay.runId))
			.unique(),
	);
	if (!activity) throw new Error("Missing activity");
	return { t, owner, member, asOwner, asMember, runId: started._yay.runId, activity };
}

describe("list_recent", () => {
	test("transfer progress is private to its owner, including for workspace owners", async () => {
		const { asOwner, asMember, owner, member, activity } = await create_transfer_activity();
		expect(await asOwner.query(api.activities.list_recent, { membershipId: owner.membershipId })).toEqual([]);
		expect(await asMember.query(api.activities.list_recent, { membershipId: member.membershipId })).toEqual([activity]);
		const denied = await asOwner.mutation(api.activities.archive_activity, {
			membershipId: owner.membershipId,
			activityId: activity._id,
		});
		expect(denied._nay?.message).toBe("Activity not found");
	});

	test("an active Paste stays reachable beyond the newest fifty activities", async () => {
		const { t, asMember, member, activity, runId } = await create_transfer_activity();
		await t.run(async (ctx) => {
			const run = await ctx.db.get("files_transfer_runs", runId);
			if (!run) throw new Error("Missing run");
			const { _id: _runId, _creationTime: _runCreationTime, ...runFields } = run;
			const { _id: _activityId, _creationTime: _activityCreationTime, ...activityFields } = activity;
			for (let index = 0; index < 51; index += 1) {
				const finishedRunId = await ctx.db.insert("files_transfer_runs", {
					...runFields,
					requestId: `finished-${index}`,
					active: false,
					phase: "completed",
					finishedAt: Date.now(),
				});
				if (activityFields.source.kind !== "files_transfer_run") throw new Error("Wrong activity source");
				await ctx.db.insert("activities", {
					...activityFields,
					status: "succeeded",
					updatedAt: Date.now() + index + 1,
					source: { ...activityFields.source, id: finishedRunId, phase: "completed" },
				});
			}
		});
		const listed = await asMember.query(api.activities.list_recent, { membershipId: member.membershipId });
		expect(listed).toHaveLength(51);
		expect(listed[0]?._id).toBe(activity._id);
	});

	test("a folder guest can still see and stop their Paste after losing workspace access", async () => {
		const { owner, member, asOwner, asMember, runId, activity } = await create_transfer_activity();
		const demoted = await asOwner.mutation(api.access_control.set_user_role, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: member.userId,
			role: null,
		});
		expect(demoted._nay).toBeUndefined();
		expect(await asMember.query(api.activities.list_recent, { membershipId: member.membershipId })).toEqual([activity]);
		const stopped = await asMember.mutation(api.files_transfer.stop, { membershipId: member.membershipId, runId });
		expect(stopped._nay).toBeUndefined();
		const dismissed = await asMember.mutation(api.activities.archive_activity, {
			membershipId: member.membershipId,
			activityId: activity._id,
		});
		expect(dismissed._nay).toBeUndefined();
		expect(await asMember.query(api.activities.list_recent, { membershipId: member.membershipId })).toEqual([]);
	});
});

describe("archive_all_activities", () => {
	test("guests can dismiss their completed Paste and cannot dismiss another owner's Paste", async () => {
		const { t, owner, member, asMember, asOwner, runId, activity } = await create_transfer_activity();
		await asMember.mutation(api.files_transfer.stop, { membershipId: member.membershipId, runId });
		const ownerDismissed = await asOwner.mutation(api.activities.archive_all_activities, {
			membershipId: owner.membershipId,
		});
		expect(ownerDismissed._yay?.count).toBe(0);
		expect((await t.run((ctx) => ctx.db.get("activities", activity._id)))?.archivedAt).toBe(0);
		const demoted = await asOwner.mutation(api.access_control.set_user_role, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: member.userId,
			role: null,
		});
		expect(demoted._nay).toBeUndefined();
		const dismissed = await asMember.mutation(api.activities.archive_all_activities, {
			membershipId: member.membershipId,
		});
		expect(dismissed._yay?.count).toBe(1);
		expect((await t.run((ctx) => ctx.db.get("activities", activity._id)))?.archivedAt).toBeGreaterThan(0);
	});
});

describe("timeout_stale_activities", () => {
	test("transfer expiry stops the producer before closing its activity", async () => {
		const { t, runId, activity } = await create_transfer_activity();
		vi.setSystemTime(Date.now() + 31 * 60 * 1000);
		await t.mutation(internal.activities.timeout_stale_activities, {});
		expect((await t.run((ctx) => ctx.db.get("activities", activity._id)))?.status).toBe("running");
		await t.mutation(internal.files_transfer.recover_expired, {});
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.phase).toBe("failed");
		expect((await t.run((ctx) => ctx.db.get("activities", activity._id)))?.status).toBe("failed");
	});
});
