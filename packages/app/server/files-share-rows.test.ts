import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api.js";
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
});
