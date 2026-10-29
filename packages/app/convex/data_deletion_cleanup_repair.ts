import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";

type RepairScope = {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	slot: Pick<Doc<"files_move_workspace_slots">, "_id" | "_creationTime" | "generation">;
	search: Pick<Doc<"files_move_search_generations">, "_id" | "_creationTime" | "searchGeneration">;
	lifetimes: Array<
		Pick<Doc<"organizations_membership_lifetimes">, "_id" | "_creationTime" | "userId" | "membershipId">
	>;
};

// Exact leftovers from the completed cleanup, read on 2026-10-29. Remove this module at Phase A.
const scopes: RepairScope[] = [
	{
		organizationId: "gs7r9fjgmr1dws3g9jmgswjh7n8cjpxt" as Id<"organizations">,
		workspaceId: "h57wjnmh62cf5xknkjh6d9kzwh8cjwrs" as Id<"organizations_workspaces">,
		slot: {
			_id: "yx7hzsp8ad99rjqxdd7r2k6d6s8g2xzz" as Id<"files_move_workspace_slots">,
			_creationTime: 1791733003052.6858,
			generation: 162,
		},
		search: {
			_id: "gx8c7kckqzm7t8ezb4xmc4e1758g4npf" as Id<"files_move_search_generations">,
			_creationTime: 1791826761358.7026,
			searchGeneration: 1137,
		},
		lifetimes: [
			{
				_id: "kh71js84w98hyp3h32jhyw9mvn8et8g3" as Id<"organizations_membership_lifetimes">,
				_creationTime: 1789960354024.3325,
				userId: "m574dezwj7y4jabxw4yapyxjvd8etxf7" as Id<"users">,
				membershipId: "h97w63wzcxqz9z5bva2j510q0h8et624" as Id<"organizations_workspaces_users">,
			},
			{
				_id: "kh7fbbxtsfaxn6drg8ss8qy1en8etbnp" as Id<"organizations_membership_lifetimes">,
				_creationTime: 1790034729169.9312,
				userId: "m575qvj9kyabtdn9jef1dgw0js8ck2dq" as Id<"users">,
				membershipId: "h97qgg7rkyvzmf6m3msay0pj5d8ckzwg" as Id<"organizations_workspaces_users">,
			},
			{
				_id: "kh7aqb9dw5d23c013z0patfmjx8ezx1p" as Id<"organizations_membership_lifetimes">,
				_creationTime: 1790178681663.8035,
				userId: "m572qhnpq7xw34askfcy6w97h18ck1f8" as Id<"users">,
				membershipId: "h97nqfq7bfn4scepbrs7118tvh8ezay4" as Id<"organizations_workspaces_users">,
			},
			{
				_id: "kh7b1v89a7pnbqnk3h8vjf68k18fkfvr" as Id<"organizations_membership_lifetimes">,
				_creationTime: 1791017195267.0056,
				userId: "m57f7hajv2kgw3rxfnv9z4bagh8ckq06" as Id<"users">,
				membershipId: "h97xnhb2m4csfz02b42gspdaex8fknjg" as Id<"organizations_workspaces_users">,
			},
		],
	},
	{
		organizationId: "gs7v73xhd5qhbsyqj761rrc3rs8gnwd2" as Id<"organizations">,
		workspaceId: "h57myt25076r38je79jkcr8c9s8gnzkq" as Id<"organizations_workspaces">,
		slot: {
			_id: "yx7v3dzrw48kps1xr2t4bcdh6n8gm7yk" as Id<"files_move_workspace_slots">,
			_creationTime: 1792538762411.5938,
			generation: 10,
		},
		search: {
			_id: "gx8evqxp3j4hdv0wpvbek2k7k98gmxv9" as Id<"files_move_search_generations">,
			_creationTime: 1792538762411.594,
			searchGeneration: 49,
		},
		lifetimes: [
			{
				_id: "kh7e3ez7w4at4spxxgpwj8dbex8gnj50" as Id<"organizations_membership_lifetimes">,
				_creationTime: 1792538762229.7935,
				userId: "m5774tmwzz27knb7mwbzjbn9t58gn6fx" as Id<"users">,
				membershipId: "h97kf7pr7mfgnpdhapd2medkj58gmst5" as Id<"organizations_workspaces_users">,
			},
		],
	},
];

async function db_repair(ctx: MutationCtx, expectedScopes: RepairScope[], preview: boolean) {
	for (const scope of expectedScopes) {
		const [organization, workspace, slot, search, indexRun] = await Promise.all([
			ctx.db.get("organizations", scope.organizationId),
			ctx.db.get("organizations_workspaces", scope.workspaceId),
			ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
				)
				.unique(),
			ctx.db
				.query("files_move_search_generations")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
				)
				.unique(),
			ctx.db
				.query("files_index_runs")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
				)
				.first(),
		]);
		if (organization || workspace) throw new Error("Repair scope is still present");
		// Every active Move or index owner uses these slot fields. An idle slot has none of them.
		if (
			!slot ||
			slot._id !== scope.slot._id ||
			slot._creationTime !== scope.slot._creationTime ||
			slot.generation !== scope.slot.generation ||
			slot.cohortId !== null ||
			"indexRunId" in slot ||
			"visibleView" in slot ||
			"migrationDirection" in slot ||
			indexRun
		) {
			throw new Error("Repair slot changed or still has work");
		}
		if (
			!search ||
			search._id !== scope.search._id ||
			search._creationTime !== scope.search._creationTime ||
			search.searchGeneration !== scope.search.searchGeneration
		) {
			throw new Error("Repair search counter changed");
		}
		for (const expected of scope.lifetimes) {
			const lifetime = await ctx.db.get("organizations_membership_lifetimes", expected._id);
			if (
				!lifetime ||
				lifetime._creationTime !== expected._creationTime ||
				lifetime.organizationId !== scope.organizationId ||
				lifetime.workspaceId !== scope.workspaceId ||
				lifetime.userId !== expected.userId ||
				lifetime.membershipId !== expected.membershipId ||
				!lifetime.active ||
				lifetime.lifetime !== 1 ||
				!expected.membershipId
			) {
				throw new Error("Repair membership lifetime changed");
			}
			if (await ctx.db.get("organizations_workspaces_users", expected.membershipId)) {
				throw new Error("Repair membership is still present");
			}
		}
	}

	let deactivatedLifetimes = 0;
	for (const scope of expectedScopes) {
		await ctx.db.delete("files_move_workspace_slots", scope.slot._id);
		await ctx.db.delete("files_move_search_generations", scope.search._id);
		for (const lifetime of scope.lifetimes) {
			// Whole-scope revocation already ended access. Do not recreate clocks or feed heads here.
			await ctx.db.patch("organizations_membership_lifetimes", lifetime._id, { active: false, lifetime: 2 });
			deactivatedLifetimes++;
		}
	}
	const result = {
		deletedSlots: expectedScopes.length,
		deletedSearchGenerations: expectedScopes.length,
		deactivatedLifetimes,
		completedAt: Date.now(),
	};
	// A thrown mutation rolls back every write. The operator must verify the unchanged docs next.
	if (preview) throw new ConvexError({ preview: 1, ...result });
	return result;
}

export const run = internalMutation({
	args: { preview: v.boolean() },
	returns: v.object({
		deletedSlots: v.number(),
		deletedSearchGenerations: v.number(),
		deactivatedLifetimes: v.number(),
		completedAt: v.number(),
	}),
	handler: async (ctx, args) => await db_repair(ctx, scopes, args.preview),
});

// Keep the test fixture outside the production bundle, as in ai_model_call_receipts.ts.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest;
	const { test_convex } = await import("./setup-base.test.ts");

	async function fixture() {
		const t = test_convex();
		const data = await t.run(async (ctx) => {
			const expectedScopes: RepairScope[] = [];
			for (const source of scopes) {
				const userId = await ctx.db.insert("users", { clerkUserId: null });
				const organizationId = await ctx.db.insert("organizations", {
					name: "repair",
					description: "",
					default: false,
					billingMode: "user",
					ownerUserId: userId,
					updatedAt: 1,
				});
				const workspaceId = await ctx.db.insert("organizations_workspaces", {
					organizationId,
					name: "repair",
					description: "",
					default: false,
					pluginInstallAccess: "owner",
					updatedAt: 1,
				});
				const slotId = await ctx.db.insert("files_move_workspace_slots", {
					organizationId,
					workspaceId,
					cohortId: null,
					generation: source.slot.generation,
				});
				const searchId = await ctx.db.insert("files_move_search_generations", {
					organizationId,
					workspaceId,
					searchGeneration: source.search.searchGeneration,
				});
				const lifetimes: RepairScope["lifetimes"] = [];
				for (const _expected of source.lifetimes) {
					const membershipId = await ctx.db.insert("organizations_workspaces_users", {
						organizationId,
						workspaceId,
						userId,
						updatedAt: 1,
						active: true,
						pendingOrganizationRemoval: false,
						displayName: "repair",
						sortDisplayName: "repair",
					});
					const id = await ctx.db.insert("organizations_membership_lifetimes", {
						organizationId,
						workspaceId,
						userId,
						membershipId,
						active: true,
						lifetime: 1,
					});
					lifetimes.push((await ctx.db.get("organizations_membership_lifetimes", id))!);
					await ctx.db.delete("organizations_workspaces_users", membershipId);
				}
				expectedScopes.push({
					organizationId,
					workspaceId,
					slot: (await ctx.db.get("files_move_workspace_slots", slotId))!,
					search: (await ctx.db.get("files_move_search_generations", searchId))!,
					lifetimes,
				});
				await ctx.db.delete("organizations_workspaces", workspaceId);
				await ctx.db.delete("organizations", organizationId);
			}
			const scope = expectedScopes[0]!;
			const preservedId = await ctx.db.insert("organizations_membership_lifetimes", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: scope.lifetimes[0]!.userId,
				membershipId: null,
				active: false,
				lifetime: 7,
			});
			return { expectedScopes, preservedId };
		});
		const read = async () =>
			await t.run(async (ctx) => ({
				slots: await ctx.db.query("files_move_workspace_slots").collect(),
				search: await ctx.db.query("files_move_search_generations").collect(),
				lifetimes: await ctx.db.query("organizations_membership_lifetimes").collect(),
				clocks: await ctx.db.query("files_media_validation_versions").collect(),
				changes: await ctx.db.query("access_control_changes").collect(),
			}));
		return { t, ...data, read };
	}

	describe("exact cleanup repair", () => {
		test("changes only the nine planned docs and preserves lifetime identity", async () => {
			const f = await fixture();
			const before = await f.read();
			const result = await f.t.mutation((ctx) => db_repair(ctx, f.expectedScopes, false));
			expect(result).toMatchObject({ deletedSlots: 2, deletedSearchGenerations: 2, deactivatedLifetimes: 5 });
			const after = await f.read();
			expect(after).toEqual({
				...before,
				slots: [],
				search: [],
				lifetimes: before.lifetimes.map((doc) =>
					doc._id === f.preservedId ? doc : { ...doc, active: false, lifetime: 2 },
				),
			});
			await expect(f.t.mutation((ctx) => db_repair(ctx, f.expectedScopes, false))).rejects.toThrow(
				"Repair slot changed",
			);
			expect(await f.read()).toEqual(after);
		});

		test("preview writes then rolls back every planned change", async () => {
			const f = await fixture();
			const before = await f.read();
			await expect(f.t.mutation((ctx) => db_repair(ctx, f.expectedScopes, true))).rejects.toMatchObject({
				data: {
					preview: 1,
					deletedSlots: 2,
					deletedSearchGenerations: 2,
					deactivatedLifetimes: 5,
					completedAt: expect.any(Number),
				},
			});
			expect(await f.read()).toEqual(before);
		});

		test("refuses a present parent before changing any planned doc", async () => {
			const f = await fixture();
			const organizationId = await f.t.run((ctx) =>
				ctx.db.insert("organizations", {
					name: "keep",
					description: "",
					default: true,
					billingMode: "user",
					ownerUserId: f.expectedScopes[0]!.lifetimes[0]!.userId,
					updatedAt: 1,
				}),
			);
			const scope = f.expectedScopes[1]!;
			scope.organizationId = organizationId;
			await f.t.run(async (ctx) => {
				await ctx.db.patch("files_move_workspace_slots", scope.slot._id, { organizationId });
				await ctx.db.patch("files_move_search_generations", scope.search._id, { organizationId });
				for (const lifetime of scope.lifetimes)
					await ctx.db.patch("organizations_membership_lifetimes", lifetime._id, { organizationId });
			});
			const before = await f.read();
			await expect(f.t.mutation((ctx) => db_repair(ctx, f.expectedScopes, false))).rejects.toThrow(
				"Repair scope is still present",
			);
			expect(await f.read()).toEqual(before);
		});

		test.each([
			"generation",
			"search",
			"lifetime",
			"membership",
			"identity",
			"move_owner",
			"index_owner",
			"scope",
		] as const)("refuses a changed %s", async (change) => {
			const f = await fixture();
			const scope = f.expectedScopes[1]!;
			await f.t.run(async (ctx) => {
				if (change === "generation")
					await ctx.db.patch("files_move_workspace_slots", scope.slot._id, { generation: 11 });
				if (change === "search")
					await ctx.db.patch("files_move_search_generations", scope.search._id, { searchGeneration: 50 });
				if (change === "lifetime")
					await ctx.db.patch("organizations_membership_lifetimes", scope.lifetimes[0]!._id, { lifetime: 2 });
				if (change === "identity")
					await ctx.db.patch("organizations_membership_lifetimes", scope.lifetimes[0]!._id, { membershipId: null });
				if (change === "move_owner")
					await ctx.db.patch("files_move_workspace_slots", scope.slot._id, {
						cohortId: "999999files_move_cohorts" as Id<"files_move_cohorts">,
						visibleView: "before",
						migrationDirection: "to_cohort",
					});
				if (change === "index_owner")
					await ctx.db.patch("files_move_workspace_slots", scope.slot._id, {
						indexRunId: "999999files_index_runs" as Id<"files_index_runs">,
						visibleView: "before",
						migrationDirection: "to_cohort",
					});
				if (change === "scope")
					await ctx.db.patch("organizations_membership_lifetimes", scope.lifetimes[0]!._id, {
						workspaceId: f.expectedScopes[0]!.workspaceId,
					});
				if (change === "membership") {
					const membershipId = await ctx.db.insert("organizations_workspaces_users", {
						organizationId: scope.organizationId,
						workspaceId: scope.workspaceId,
						userId: scope.lifetimes[0]!.userId,
						updatedAt: 1,
						active: true,
						pendingOrganizationRemoval: false,
						displayName: "keep",
						sortDisplayName: "keep",
					});
					scope.lifetimes[0]!.membershipId = membershipId;
					await ctx.db.patch("organizations_membership_lifetimes", scope.lifetimes[0]!._id, { membershipId });
				}
			});
			const before = await f.read();
			await expect(f.t.mutation((ctx) => db_repair(ctx, f.expectedScopes, false))).rejects.toThrow("Repair");
			expect(await f.read()).toEqual(before);
		});

		test("refuses an index run even when the slot looks idle", async () => {
			const f = await fixture();
			const scope = f.expectedScopes[1]!;
			await f.t.run((ctx) =>
				ctx.db.insert("files_index_runs", {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					fileNodeId: "999999files_nodes" as Id<"files_nodes">,
					indexRevision: 1,
					contentRevision: 1,
					contentHeadId: null,
					previousHeadId: null,
					chunkCount: 0,
					textKind: "plain_text",
					placement: {
						parentId: "root",
						kind: "file",
						name: "test",
						sortName: "test",
						path: "/test",
						treePath: "/test/",
						archiveOperationId: null,
						restrictedScopeNodeId: null,
						isRestrictedScopeRoot: false,
					},
					phase: "build_text",
					cursor: null,
					nextPosition: 0,
					step: 0,
					generation: 1,
					nextAttemptAt: 1,
					scheduledId: null,
					slotGeneration: null,
					published: false,
					aborting: false,
					error: null,
				}),
			);
			const before = await f.read();
			await expect(f.t.mutation((ctx) => db_repair(ctx, f.expectedScopes, false))).rejects.toThrow(
				"Repair slot changed or still has work",
			);
			expect(await f.read()).toEqual(before);
		});
	});
}
