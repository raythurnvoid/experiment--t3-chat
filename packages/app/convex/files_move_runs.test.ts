import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
import { advance, files_transfer_db_request_stop } from "./files_transfer.ts";
import { organizations_membership_lifetimes_db_record } from "./organizations_membership_lifetimes.ts";
import { files_TRANSFER_SELECTION_PAGE_SIZE } from "../shared/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function create_fixture(paths: string[]) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodes = new Map<string, Id<"files_nodes">>();
	for (const path of ["/target", ...paths]) {
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		nodes.set(path, created._yay.nodeId);
	}
	return { t, db, asUser, nodes };
}

async function start_move(fixture: Awaited<ReturnType<typeof create_fixture>>, sourceIds: Id<"files_nodes">[]) {
	const { asUser, db, nodes } = fixture;
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId: db.membershipId,
		requestId: "paged-move",
		kind: "move",
		expectedSourceCount: sourceIds.length,
		sourceIds: sourceIds.slice(0, files_TRANSFER_SELECTION_PAGE_SIZE),
		targetParentId: nodes.get("/target")!,
	});
	expect(started._nay, "Move accepts its first input page").toBeUndefined();
	if (started._nay) throw new Error(started._nay.message);
	const { runId } = started._yay;
	for (
		let offset = files_TRANSFER_SELECTION_PAGE_SIZE;
		offset < sourceIds.length;
		offset += files_TRANSFER_SELECTION_PAGE_SIZE
	) {
		expect(
			await asUser.mutation(api.files_transfer.append_sources, {
				membershipId: db.membershipId,
				runId,
				offset,
				sourceIds: sourceIds.slice(offset, offset + files_TRANSFER_SELECTION_PAGE_SIZE),
			}),
			`Move accepts input page at ${offset}`,
		).toEqual({ _yay: null });
	}
	expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	return started._yay;
}

describe("paged Move runs", () => {
	test("moves 201 selected roots through scheduled steps", async () => {
		const paths = Array.from({ length: 201 }, (_, index) => `/source-${index.toString().padStart(3, "0")}`);
		const fixture = await create_fixture(paths);
		const { t, db, asUser, nodes } = fixture;
		const { runId } = await start_move(fixture, paths.map((path) => nodes.get(path)!));

		// Each saved root now needs its own paged cohort and cleanup.
		await t.finishAllScheduledFunctions(vi.runAllTimers, 50_000);

		expect(
			await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }),
			"all 201 selected roots complete",
		).toMatchObject({
			activity: { status: "succeeded", progress: { total: 201, completed: 201, canceled: 0, failed: 0 } },
		});
		for (const path of paths) {
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodes.get(path)!))).toMatchObject({
				parentId: nodes.get("/target"),
				path: `/target${path}`,
			});
		}
	}, 7_200_000);

	test.each(["none", "stop", "reinvite"] as const)(
		"keeps completed roots when the next step sees %s",
		async (interruption) => {
			const fixture = await create_fixture(["/a", "/a/child", "/b"]);
			const { t, nodes } = fixture;
			const member = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "move-member" });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: fixture.db.organizationId,
					workspaceId: fixture.db.workspaceId,
					userId, active: true, updatedAt: Date.now(),
					pendingOrganizationRemoval: false,
				});
				await ctx.db.insert("access_control_role_assignments", {
					organizationId: fixture.db.organizationId,
					workspaceId: fixture.db.workspaceId,
					userId, role: "member", createdAt: Date.now(), updatedAt: Date.now(),
				});
				return { userId, membershipId };
			});
			const actor = {
				...fixture,
				db: { ...fixture.db, ...member },
				asUser: t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId }),
			};
			const { runId, activityId } = await start_move(actor, [nodes.get("/a")!, nodes.get("/b")!]);
			let reachedFirstRoot = false;
			test_spy_handler(advance, async (handler, ctx, args) => {
				const result = await handler(ctx, args);
				const activity = await ctx.db.get("activities", activityId);
				if (reachedFirstRoot || activity?.progress?.completed !== 1) return result;
				reachedFirstRoot = true;
				if (interruption === "stop") {
					await files_transfer_db_request_stop(ctx, { runId, reason: "user", now: Date.now() });
				} else if (interruption === "reinvite") {
					const membership = (await ctx.db.get("organizations_workspaces_users", member.membershipId))!;
					await ctx.db.patch("organizations_workspaces_users", membership._id, { active: false });
					await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: false }]);
					await ctx.db.patch("organizations_workspaces_users", membership._id, { active: true });
					await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: true }]);
				}
				return result;
			});
			await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
			expect(reachedFirstRoot, "the first root publishes before access or Stop changes").toBe(true);
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodes.get("/a/child")!))).toMatchObject({
				path: "/target/a/child",
			});
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodes.get("/b")!)), "the old membership cannot move the next root").toMatchObject({
				path: interruption === "none" ? "/target/b" : "/b",
			});
			expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
				status: interruption === "none" ? "succeeded" : interruption === "stop" ? "canceled" : "partial",
				progress: { completed: interruption === "none" ? 2 : 1, canceled: interruption === "none" ? 0 : 1 },
				...(interruption === "reinvite" ? { errorMessage: "Permission denied" } : {}),
			});
			await t.mutation(internal.files_transfer.advance, { runId });
			await t.mutation(internal.files_transfer.advance, { runId });
			expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
				progress: { completed: interruption === "none" ? 2 : 1 },
			});
		},
	);
});
