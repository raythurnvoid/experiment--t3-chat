import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { test_create_saved_placement_fixture as fixture } from "./files-saved-placement.test-fixtures.ts";
import { files_share_rows_db_compute_all_for_grant } from "./files-share-rows.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("share-rows-test-work" as never);
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

async function shared_fixture() {
	const f = await fixture();
	const member = await f.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: null });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
		});
		await ctx.db.patch("files_nodes", f.nodeId, { restrictedScopeNodeId: f.nodeId, isRestrictedScopeRoot: true });
		for (const view of ["before", "after"] as const) {
			const place = await ctx.db
				.query("files_saved_places")
				.withIndex("by_cohort_view_node", (q) => q.eq("cohortId", f.cohortId).eq("view", view).eq("nodeId", f.nodeId))
				.unique();
			if (!place) throw new Error("Expected the candidate");
			await ctx.db.patch("files_saved_places", place._id, {
				restrictedScopeNodeId: f.nodeId,
				isRestrictedScopeRoot: true,
			});
		}
		return { userId, membershipId };
	});
	const asOwner = f.t.withIdentity({ issuer: "https://clerk.test", external_id: f.db.userId });
	const asMember = f.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
	const principal = { kind: "user" as const, userId: member.userId };
	expect(
		await asOwner.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			principal,
			level: "read",
		}),
	).toEqual({ _yay: null });
	return { ...f, member, asOwner, asMember, principal };
}

describe("share rows during a Move", () => {
	test("stores both candidates from a live public grant and serves only the chosen view", async () => {
		const f = await shared_fixture();
		const rows = await f.t.run((ctx) =>
			ctx.db
				.query("files_share_rows")
				.withIndex("by_node", (q) => q.eq("nodeId", f.nodeId))
				.collect(),
		);
		expect(rows.map((row) => [row.moveView?.view, row.name]).sort()).toEqual([
			["after", "new.txt"],
			["before", "old.txt"],
		]);
		const read = (view: "before" | "after") =>
			f.asMember.query(api.files_nodes.list_tree_shared_roots, {
				membershipId: f.member.membershipId,
				principalIndex: 0,
				archived: false,
				savedStream: { kind: "cohort", cohortId: f.cohortId, view, generation: 1 },
				paginationOpts: { cursor: null, numItems: 20 },
			});
		expect((await read("before")).page.map((row) => row.name)).toEqual(["old.txt"]);
		expect(
			(
				await f.asMember.query(api.files_nodes.list_tree_shared_roots, {
					membershipId: f.member.membershipId,
					principalIndex: 0,
					archived: false,
					savedStream: { kind: "normal", generation: 1 },
					paginationOpts: { cursor: null, numItems: 20 },
				})
			).page,
		).toEqual([]);
		await f.publish();
		expect((await read("after")).page.map((row) => row.name)).toEqual(["new.txt"]);
		await expect(read("before")).rejects.toThrow("InvalidCursor");
	});

	test("revoking a public grant deletes every candidate before publication", async () => {
		const f = await shared_fixture();
		const grant = await f.t.run((ctx) =>
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_resource_permission", (q) =>
					q
						.eq("organizationId", f.db.organizationId)
						.eq("workspaceId", f.db.workspaceId)
						.eq("resourceKind", "file")
						.eq("resourceId", f.nodeId)
						.eq("permission", "content.read"),
				)
				.unique(),
		);
		expect(await f.t.run((ctx) => files_share_rows_db_compute_all_for_grant(ctx.db, grant))).toHaveLength(2);
		expect(
			await f.asOwner.mutation(api.files_sharing.remove_node_share_grant, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				principal: f.principal,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_share_rows")
					.withIndex("by_node", (q) => q.eq("nodeId", f.nodeId))
					.collect(),
			),
			"revocation removes both Move candidates at once",
		).toEqual([]);
		await f.publish();
		expect(
			(
				await f.asMember.query(api.files_nodes.list_tree_shared_roots, {
					membershipId: f.member.membershipId,
					principalIndex: 0,
					archived: false,
					savedStream: { kind: "cohort", cohortId: f.cohortId, view: "after", generation: 1 },
					paginationOpts: { cursor: null, numItems: 20 },
				})
			).page,
		).toEqual([]);
	});

	// Each share row copies the long name. If the Move read the node and its places again for every
	// grant, 50 shares of a 19,000-char folder would read more than 16 MiB in one step.
	test("moves a restricted folder with 50 shares and a long name", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const folder = async (path: string) => {
			const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path,
			});
			if (created._nay) throw new Error(created._nay.message);
			return created._yay.nodeId;
		};
		const sourceId = await folder(`/${"n".repeat(19_000)}`);
		const targetId = await folder("/target");
		const userIds = await t.run(async (ctx) => {
			const ids = [];
			for (let index = 0; index < 50; index++) {
				const userId = await ctx.db.insert("users", { clerkUserId: `clerk_share_rows_${index}` });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				ids.push(userId);
			}
			return ids;
		});
		// Advance only the clock between sharing writes, so their rate limit refills.
		vi.setSystemTime(Date.now() + 3_000);
		expect(
			await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: sourceId }),
		).toEqual({ _yay: null });
		for (const userId of userIds) {
			vi.setSystemTime(Date.now() + 3_000);
			expect(
				await asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: db.membershipId,
					nodeId: sourceId,
					principal: { kind: "user", userId },
					level: "manage",
				}),
			).toEqual({ _yay: null });
		}

		const started = await asOwner.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "share-rows-long-name",
			kind: "move",
			sourceIds: [sourceId],
			expectedSourceCount: 1,
			targetParentId: targetId,
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await asOwner.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId: started._yay.runId }),
		).toEqual({ _yay: null });
		for (let step = 0; step < 3_000; step++) {
			vi.advanceTimersByTime(0);
			await t.finishInProgressScheduledFunctions();
			const activity = await t.run((ctx) => ctx.db.get("activities", started._yay.activityId));
			if (activity?.finishedAt !== undefined || vi.getTimerCount() === 0) break;
			vi.advanceTimersToNextTimer();
		}

		expect(
			await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId: started._yay.runId }),
		).toMatchObject({ activity: { status: "succeeded", progress: { completed: 1 } } });
		const rows = await t.run((ctx) =>
			ctx.db
				.query("files_share_rows")
				.withIndex("by_node", (q) => q.eq("nodeId", sourceId))
				.collect(),
		);
		expect(rows.map((row) => [row.parentId, row.moveView])).toEqual(Array(50).fill([targetId, undefined]));
	}, 120_000);
});
