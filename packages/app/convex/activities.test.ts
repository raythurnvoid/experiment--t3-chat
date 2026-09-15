import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { activities_db_add_target, activities_get_result_status } from "./activities_db.ts";
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

describe("activities_get_result_status", () => {
	test.each([
		{ completed: 0, failed: 0, blocked: 0, canceled: 0, status: "succeeded" },
		{ completed: 1, failed: 0, blocked: 0, canceled: 0, status: "succeeded" },
		{ completed: 1, failed: 1, blocked: 0, canceled: 0, status: "partial" },
		{ completed: 1, failed: 0, blocked: 1, canceled: 0, status: "partial" },
		{ completed: 1, failed: 0, blocked: 0, canceled: 1, status: "partial" },
		{ completed: 0, failed: 1, blocked: 0, canceled: 1, status: "failed" },
		{ completed: 0, failed: 0, blocked: 1, canceled: 1, status: "failed" },
		{ completed: 0, failed: 0, blocked: 0, canceled: 1, status: "canceled" },
	])("reports $status for $completed completed, $failed failed, $blocked blocked, $canceled canceled", (progress) => {
		expect(activities_get_result_status(progress)).toBe(progress.status);
	});
});

describe("activities_db_add_target", () => {
	test("lists a target once and stops growing at twenty", async () => {
		const { t, owner, asOwner, runId, activity } = await create_transfer_activity();
		const nodeIds: Id<"files_nodes">[] = [];
		for (let index = 0; index < 21; index += 1) {
			const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: owner.membershipId,
				parentId: files_ROOT_ID,
				path: `target-${index.toString().padStart(2, "0")}`,
			});
			if (created._nay) throw new Error(created._nay.message);
			nodeIds.push(created._yay.nodeId);
		}
		const add = async (index: number, now: number) =>
			await t.run((ctx) =>
				activities_db_add_target(ctx, {
					sourceId: runId,
					target: { kind: "file_node", id: nodeIds[index]!, path: `/target-${index}`, message: "" },
					now,
				}),
			);

		// A touch and the write that follows it name the same file, so the second call must not list
		// it twice, and it must still advance the job.
		await add(0, 1_000);
		await add(0, 2_000);
		expect(await t.run((ctx) => ctx.db.get("activities", activity._id))).toMatchObject({
			targets: [{ id: nodeIds[0], path: "/target-0" }],
			updatedAt: 2_000,
		});

		for (let index = 1; index < 21; index += 1) await add(index, 3_000 + index);
		const capped = await t.run((ctx) => ctx.db.get("activities", activity._id));
		expect(capped?.targets).toHaveLength(20);
		expect(capped?.targets.at(-1)?.id).toBe(nodeIds[19]);
		expect(capped?.targets.some((target) => target.id === nodeIds[20])).toBe(false);
		// The dropped target still advances the job it belongs to.
		expect(capped?.updatedAt).toBe(3_020);
	});
});

describe("list_page", () => {
	test("transfer progress and controls are private to its requester", async () => {
		const { asOwner, asMember, owner, member, activity } = await create_transfer_activity();
		expect(
			(
				await asOwner.query(api.activities.list_page, {
					membershipId: owner.membershipId,
					section: "active",
					paginationOpts: { cursor: null, numItems: 50 },
				})
			).page,
		).toEqual([]);
		const listed = await asMember.query(api.activities.list_page, {
			membershipId: member.membershipId,
			section: "active",
			paginationOpts: { cursor: null, numItems: 50 },
		});
		expect(listed.page).toEqual([{ ...activity, controls: { canStop: true, canRetry: false, canDismiss: false } }]);
		const denied = await asOwner.mutation(api.activities.archive_activity, {
			membershipId: owner.membershipId,
			activityId: activity._id,
		});
		expect(denied._nay?.message).toBe("Activity not found");
	});

	test("an active Paste stays reachable beyond fifty newer finished jobs", async () => {
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
				});
				await ctx.db.insert("activities", {
					...activityFields,
					status: "succeeded",
					finishedAt: Date.now() + index + 1,
					updatedAt: Date.now() + index + 1,
					source: { kind: "files_transfer_run", id: finishedRunId, transferKind: run.kind },
				});
			}
		});
		const active = await asMember.query(api.activities.list_page, {
			membershipId: member.membershipId,
			section: "active",
			paginationOpts: { cursor: null, numItems: 50 },
		});
		// The active section reads a different index range than history, so newer finished cards cannot
		// push the running Paste off the page or take its Stop button away.
		expect(active.page).toEqual([{ ...activity, controls: { canStop: true, canRetry: false, canDismiss: false } }]);
		const history = await asMember.query(api.activities.list_page, {
			membershipId: member.membershipId,
			section: "history",
			paginationOpts: { cursor: null, numItems: 50 },
		});
		expect(history.page).toHaveLength(50);
		expect(history.isDone).toBe(false);
		const next = await asMember.query(api.activities.list_page, {
			membershipId: member.membershipId,
			section: "history",
			paginationOpts: { cursor: history.continueCursor, numItems: 50 },
		});
		expect(next.page).toHaveLength(1);
		expect(next.isDone).toBe(true);
	});

	test("a hidden page still returns a continuation", async () => {
		const { t, asOwner, owner, activity, runId } = await create_transfer_activity();
		await t.run(async (ctx) => {
			const run = await ctx.db.get("files_transfer_runs", runId);
			if (!run) throw new Error("Missing run");
			const { _id: _runId, _creationTime: _runCreationTime, ...runFields } = run;
			const { _id: _activityId, _creationTime: _activityCreationTime, ...activityFields } = activity;
			for (let index = 0; index < 51; index += 1) {
				const id = await ctx.db.insert("files_transfer_runs", {
					...runFields,
					requestId: `hidden-${index}`,
				});
				await ctx.db.insert("activities", {
					...activityFields,
					status: "succeeded",
					finishedAt: Date.now() + index + 1,
					source: { kind: "files_transfer_run", id, transferKind: run.kind },
				});
			}
		});
		const page = await asOwner.query(api.activities.list_page, {
			membershipId: owner.membershipId,
			section: "history",
			paginationOpts: { cursor: null, numItems: 50 },
		});
		expect(page.page).toEqual([]);
		expect(page.isDone).toBe(false);
		expect(page.continueCursor).not.toBe("");
	});
});

describe("request_stop", () => {
	test("only the requester can stop the job and repeating Stop keeps its result", async () => {
		const { t, asOwner, asMember, owner, member, activity, runId } = await create_transfer_activity();
		const denied = await asOwner.mutation(api.activities.request_stop, {
			membershipId: owner.membershipId,
			activityId: activity._id,
		});
		expect(denied._nay?.message).toBe("Activity not found");
		expect(await t.run((ctx) => ctx.db.get("activities", activity._id))).toEqual(activity);
		const stopped = await asMember.mutation(api.activities.request_stop, {
			membershipId: member.membershipId,
			activityId: activity._id,
		});
		expect(stopped._nay).toBeUndefined();
		const finished = await t.run((ctx) => ctx.db.get("activities", activity._id));
		expect(finished).toMatchObject({ status: "canceled", progress: { completed: 0, canceled: 1 } });
		vi.setSystemTime(Date.now() + 1000);
		expect(
			(
				await asMember.mutation(api.activities.request_stop, {
					membershipId: member.membershipId,
					activityId: activity._id,
				})
			)._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("activities", activity._id))).toEqual(finished);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			),
		).toMatchObject([{ state: "canceled" }]);
	});
});

describe("recover_expired", () => {
	test("uses the execution deadline and settles a transfer through its producer", async () => {
		const { t, activity, runId } = await create_transfer_activity();
		expect(await t.mutation(internal.activities.recover_expired, { _test_now: activity.deadlineAt - 1 })).toEqual({
			processedCount: 0,
			done: true,
		});
		expect(await t.run((ctx) => ctx.db.get("activities", activity._id))).toEqual(activity);
		expect(await t.mutation(internal.activities.recover_expired, { _test_now: activity.deadlineAt })).toEqual({
			processedCount: 1,
			done: true,
		});
		const finished = await t.run((ctx) => ctx.db.get("activities", activity._id));
		expect(finished).toMatchObject({ status: "timed_out", progress: { completed: 0, canceled: 1 } });
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			),
		).toMatchObject([{ state: "canceled", outputTarget: null }]);
	});
});

describe("cleanup_history", () => {
	test("keeps unexpired history and removes expired transfer receipts without deleting files", async () => {
		const { t, asMember, member, activity, runId } = await create_transfer_activity();
		await asMember.mutation(api.activities.request_stop, {
			membershipId: member.membershipId,
			activityId: activity._id,
		});
		const files = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const finished = await t.run((ctx) => ctx.db.get("activities", activity._id));
		if (finished?.expiresAt === undefined) throw new Error("Missing history expiry");
		expect(await t.mutation(internal.activities.cleanup_history, { _test_now: finished.expiresAt - 1 })).toEqual({
			deletedCount: 0,
			done: true,
		});
		expect(await t.run((ctx) => ctx.db.get("activities", activity._id))).toEqual(finished);
		expect(await t.mutation(internal.activities.cleanup_history, { _test_now: finished.expiresAt })).toEqual({
			deletedCount: 3,
			done: true,
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.get("activities", activity._id)).toBeNull();
			expect(await ctx.db.get("files_transfer_runs", runId)).toBeNull();
			expect(await ctx.db.query("files_transfer_items").collect()).toEqual([]);
			expect(await ctx.db.query("files_nodes").collect()).toEqual(files);
		});
	});
});

describe("archive_activity", () => {
	test.each(["queued", "running", "awaiting_input", "stopping"] as const)("cannot dismiss %s work", async (status) => {
		const { t, asMember, member, activity } = await create_transfer_activity();
		await t.run((ctx) => ctx.db.patch("activities", activity._id, { status }));
		const result = await asMember.mutation(api.activities.archive_activity, {
			membershipId: member.membershipId,
			activityId: activity._id,
		});
		expect(result._nay?.message).toBe("Activity is still running");
		expect(await t.run((ctx) => ctx.db.query("activities_user_states").collect())).toEqual([]);
	});

	test("a folder guest can stop and dismiss their own Paste", async () => {
		const { t, owner, member, asOwner, asMember, runId, activity } = await create_transfer_activity();
		const demoted = await asOwner.mutation(api.access_control.set_user_role, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: member.userId,
			role: null,
		});
		expect(demoted._nay).toBeUndefined();
		const active = await asMember.query(api.activities.list_page, {
			membershipId: member.membershipId,
			section: "active",
			paginationOpts: { cursor: null, numItems: 50 },
		});
		expect(active.page[0]?.controls.canStop).toBe(true);
		const stopped = await asMember.mutation(api.activities.request_stop, {
			membershipId: member.membershipId,
			activityId: activity._id,
		});
		expect(stopped._nay).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		const dismissed = await asMember.mutation(api.activities.archive_activity, {
			membershipId: member.membershipId,
			activityId: activity._id,
		});
		expect(dismissed._nay).toBeUndefined();
		expect(
			(
				await asMember.query(api.activities.list_page, {
					membershipId: member.membershipId,
					section: "history",
					paginationOpts: { cursor: null, numItems: 50 },
				})
			).page,
		).toEqual([]);
	});
});

describe("archive_all_activities", () => {
	test("dismisses only the requester's finished Paste and stores viewer state", async () => {
		const { t, owner, member, asMember, asOwner, runId, activity } = await create_transfer_activity();
		await asMember.mutation(api.files_transfer.stop, { membershipId: member.membershipId, runId });
		await t.mutation(internal.files_transfer.advance, { runId });
		const ownerDismissed = await asOwner.mutation(api.activities.archive_all_activities, {
			membershipId: owner.membershipId,
			cursor: null,
		});
		expect(ownerDismissed._yay?.count).toBe(0);
		const dismissed = await asMember.mutation(api.activities.archive_all_activities, {
			membershipId: member.membershipId,
			cursor: null,
		});
		expect(dismissed._yay?.count).toBe(1);
		expect(await t.run((ctx) => ctx.db.query("activities_user_states").collect())).toMatchObject([
			{ userId: member.userId, activityId: activity._id },
		]);
		expect((await t.run((ctx) => ctx.db.get("activities", activity._id)))?.status).toBe("canceled");
	});
});
