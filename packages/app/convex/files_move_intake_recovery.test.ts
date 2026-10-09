import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { organizations_membership_lifetimes_db_record } from "./organizations_membership_lifetimes.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function create_fixture(kind: "move" | "copy" = "move") {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const source = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/source",
	});
	if (source._nay) throw new Error(source._nay.message);
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId: db.membershipId,
		requestId: "saved-request",
		kind,
		expectedSourceCount: 1,
		sourceIds: [source._yay.nodeId],
		targetParentId: "root",
	});
	if (started._nay) throw new Error(started._nay.message);
	return { t, db, asUser, ...started._yay };
}

async function reinvite(fixture: Awaited<ReturnType<typeof create_fixture>>) {
	await fixture.t.run(async (ctx) => {
		const membership = (await ctx.db.get("organizations_workspaces_users", fixture.db.membershipId))!;
		await ctx.db.patch("organizations_workspaces_users", membership._id, { active: false });
		await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: false }]);
		await ctx.db.patch("organizations_workspaces_users", membership._id, { active: true });
		await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: true }]);
	});
}

describe("Move intake recovery lookup", () => {
	test("returns only the owned Move request state", async () => {
		const { t, db, asUser, runId } = await create_fixture();
		expect(
			await asUser.query(api.files_transfer.get_move_intake, {
				membershipId: db.membershipId,
				requestId: "saved-request",
			}),
		).toEqual({ runId, step: "uploading", isFinished: false });
		expect(
			await asUser.query(api.files_transfer.get_move_intake, {
				membershipId: db.membershipId,
				requestId: "missing-request",
			}),
		).toBeNull();
		await expect(
			t.query(api.files_transfer.get_move_intake, {
				membershipId: db.membershipId,
				requestId: "saved-request",
			}),
		).rejects.toThrow("Unauthenticated");
	});

	test("hides requests from another user or workspace and hides Copy", async () => {
		const { t, db, asUser } = await create_fixture();
		const otherUser = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-user-org" }),
		);
		const otherWorkspace = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				userId: db.userId,
				organizationName: "other-org",
				workspaceName: "other-workspace",
			}),
		);
		const asOtherUser = t.withIdentity({ issuer: "https://clerk.test", external_id: otherUser.userId });
		expect(
			await asOtherUser.query(api.files_transfer.get_move_intake, {
				membershipId: db.membershipId,
				requestId: "saved-request",
			}),
		).toBeNull();
		expect(
			await asOtherUser.query(api.files_transfer.get_move_intake, {
				membershipId: otherUser.membershipId,
				requestId: "saved-request",
			}),
		).toBeNull();
		expect(
			await asUser.query(api.files_transfer.get_move_intake, {
				membershipId: otherWorkspace.membershipId,
				requestId: "saved-request",
			}),
		).toBeNull();
		const copy = await create_fixture("copy");
		expect(
			await copy.asUser.query(api.files_transfer.get_move_intake, {
				membershipId: copy.db.membershipId,
				requestId: "saved-request",
			}),
		).toBeNull();
	});

	test("hides a live request from an old membership lifetime", async () => {
		const fixture = await create_fixture();
		await reinvite(fixture);
		expect(
			await fixture.asUser.query(api.files_transfer.get_move_intake, {
				membershipId: fixture.db.membershipId,
				requestId: "saved-request",
			}),
		).toBeNull();
	});

	test("returns a terminal old-lifetime request so the browser can retire input", async () => {
		const fixture = await create_fixture();
		expect(
			await fixture.asUser.mutation(api.files_transfer.stop, {
				membershipId: fixture.db.membershipId,
				runId: fixture.runId,
			}),
		).toEqual({ _yay: null });
		await fixture.t.finishAllScheduledFunctions(vi.runAllTimers);
		await reinvite(fixture);
		expect(
			await fixture.asUser.query(api.files_transfer.get_move_intake, {
				membershipId: fixture.db.membershipId,
				requestId: "saved-request",
			}),
		).toMatchObject({ runId: fixture.runId, isFinished: true });
	});
});

describe("Move Stop recovery", () => {
	test("confirms Stop after normal history cleanup removes the run", async () => {
		const { t, db, asUser, runId, activityId } = await create_fixture();
		const args = { membershipId: db.membershipId, runId };
		expect(await asUser.mutation(api.files_transfer.stop, args)).toEqual({ _yay: null });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const finished = await t.run((ctx) => ctx.db.get("activities", activityId));
		if (finished?.expiresAt === undefined) throw new Error("Missing history expiry");
		for (let step = 0; step < 2; step++) {
			await t.mutation(internal.activities.cleanup_history, {
				_test_now: finished.expiresAt,
				_test_disableReschedule: true,
			});
		}
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toBeNull();
		expect(await asUser.mutation(api.files_transfer.stop, args), "Stop succeeds after its run history is gone").toEqual({
			_yay: null,
		});
	});

	test("does not change a run through another owned tenant membership", async () => {
		const { t, db, asUser, runId, activityId } = await create_fixture();
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				userId: db.userId,
				organizationName: "other-org",
				workspaceName: "other-workspace",
			}),
		);
		const before = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_transfer_runs", runId),
			activity: await ctx.db.get("activities", activityId),
		}));
		expect(
			await asUser.mutation(api.files_transfer.stop, { membershipId: other.membershipId, runId }),
		).toEqual({ _yay: null });
		expect(
			await t.run(async (ctx) => ({
				run: await ctx.db.get("files_transfer_runs", runId),
				activity: await ctx.db.get("activities", activityId),
			})),
		).toEqual(before);
	});

	test("keeps authentication and membership refusals", async () => {
		const { t, db, asUser, runId, activityId } = await create_fixture();
		const args = { membershipId: db.membershipId, runId };
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-user-org" }),
		);
		const before = await t.run((ctx) => ctx.db.get("activities", activityId));
		expect(await t.mutation(api.files_transfer.stop, args)).toEqual({ _nay: { message: "Unauthenticated" } });
		expect(
			await asUser.mutation(api.files_transfer.stop, { membershipId: other.membershipId, runId }),
		).toEqual({ _nay: { message: "Unauthorized" } });
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", db.membershipId, { active: false }));
		expect(await asUser.mutation(api.files_transfer.stop, args)).toEqual({ _nay: { message: "Unauthorized" } });
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toEqual(before);
	});
});
