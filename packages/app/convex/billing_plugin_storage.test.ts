import { afterEach, describe, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { organizations_db_ensure_default_organization_and_workspace_for_user } from "./organizations.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

const DAY_1_MS = Date.parse("2026-04-10T01:30:00.000Z");
const DAY_1_LATER_MS = Date.parse("2026-04-10T23:59:00.000Z");
const DAY_2_MS = Date.parse("2026-04-11T01:30:00.000Z");
const DAY_3_MS = Date.parse("2026-04-12T01:30:00.000Z");

/** ~€0.15/GiB-month means one GiB held for one day accrues half a cent. */
const GIB = 1024 * 1024 * 1024;

type MeterFixture = {
	userId: Id<"users">;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
};

/**
 * Seed one workspace whose installation accounting doc holds the given bytes.
 *
 * The metering pass reads these docs directly, so the seed skips the whole write
 * pipeline — the same direct-seed approach plugins_data.test.ts uses for ceiling
 * tests. A payer without `clerkUserId` is anonymous for billing: their charge is
 * applied locally to the plan snapshot instead of queued for Polar. `plan: null`
 * leaves the payer with no billing state at all.
 */
async function seed_metered_workspace(
	t: ReturnType<typeof test_convex>,
	args: {
		organizationName?: string;
		storedBytes?: number;
		reservedBytes?: number;
		plan?: "Free" | "Pay As You Go" | "Pro" | null;
		clerkUserId?: string;
	} = {},
): Promise<MeterFixture> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		let userId = args.clerkUserId
			? ((await ctx.db.insert("users", { clerkUserId: args.clerkUserId })) as Id<"users">)
			: undefined;
		const membership = await test_mocks_fill_db_with.membership(ctx, {
			organizationName: args.organizationName,
			...(userId === undefined ? {} : { userId }),
			...(args.plan === undefined ? {} : { plan: args.plan }),
		});
		userId = membership.userId;
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "council",
			displayName: "Council",
			version: "0.1.0",
			description: "",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/bonobo/council-plugin",
			sourceOwner: "bonobo",
			sourceRepo: "council-plugin",
			sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
			manifestR2Key: "plugins/council/manifest.json",
			backendEntrypointFile: null,
			configuration: null,
			events: [],
			capabilities: [],
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: membership.userId,
			updatedAt: now,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			pluginVersionId,
			pluginName: "council",
			status: "enabled",
			configurationYaml: null,
			acceptedCapabilities: [],
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			outboundOriginsAcceptedAt: now,
			installedBy: membership.userId,
			updatedBy: membership.userId,
			updatedAt: now,
		});
		await ctx.db.insert("plugins_data_usage", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId,
			pluginName: "council",
			usedBytes: args.storedBytes ?? 0,
			reservedBytes: args.reservedBytes ?? 0,
			usedDocuments: 0,
			reservedDocuments: 0,
			tombstoneDocuments: 0,
			collectionNames: [],
			updatedAt: now,
		});

		return {
			userId: membership.userId,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
		};
	});
}

/** Move the payer's stored bytes without going through a write door. */
async function set_stored_bytes(
	t: ReturnType<typeof test_convex>,
	args: { workspaceId: Id<"organizations_workspaces">; storedBytes: number },
) {
	await t.run(async (ctx) => {
		for await (const usage of ctx.db.query("plugins_data_usage")) {
			if (usage.workspaceId === args.workspaceId) {
				await ctx.db.patch("plugins_data_usage", usage._id, { usedBytes: args.storedBytes });
			}
		}
	});
}

async function read_accrual(t: ReturnType<typeof test_convex>, fixture: MeterFixture) {
	return await t.run(async (ctx) =>
		ctx.db
			.query("billing_usage_accruals")
			.withIndex("by_billedUser_organization_workspace_kind", (q) =>
				q
					.eq("billedUserId", fixture.userId)
					.eq("organizationId", fixture.organizationId)
					.eq("workspaceId", fixture.workspaceId)
					.eq("usageKind", "plugin_storage"),
			)
			.first(),
	);
}

/**
 * Workpool `enqueueAction` FunctionReferences do not compare with `===` in these
 * tests, and seed leftover jobs can share the spy. Match the billed event name.
 */
function queued_plugin_storage_events(spy: { mock: { calls: unknown[][] } }) {
	return spy.mock.calls.flatMap((call) => {
		const payload = call[2];
		if (!payload || typeof payload !== "object" || !("events" in payload)) {
			return [];
		}

		const events = (payload as { events: Array<{ name?: string }> }).events;
		if (!Array.isArray(events)) {
			return [];
		}

		return events.filter((event) => event.name === "plugin_storage");
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("meter_plugin_storage_usage", () => {
	test("accrues below one cent silently, then emits once a cent builds up across days", async () => {
		const t = test_convex();
		const fixture = await seed_metered_workspace(t, { storedBytes: GIB, plan: null, clerkUserId: "meter-payer" });
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_plugin_storage_day1" as never);

		// Day 1: 1 GiB-day is half a cent, so nothing is charged yet but the reading is kept.
		await t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_1_MS });
		expect(enqueueActionSpy).not.toHaveBeenCalled();
		const accrual1 = await read_accrual(t, fixture);
		expect(accrual1?.fractionalCents ?? 0).toBeGreaterThan(0.4);
		expect(accrual1?.fractionalCents ?? 1).toBeLessThan(0.6);
		expect(accrual1).toMatchObject({ lastMeteredDay: "2026-04-10" });

		// Day 2 crosses one cent: exactly one event fires and spends the carried remainder.
		vi.mocked(enqueueActionSpy).mockClear();
		await t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_2_MS });
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect(enqueueActionSpy).toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.objectContaining({
				events: [
					expect.objectContaining({
						name: "plugin_storage",
						externalCustomerId: fixture.userId,
						metadata: expect.objectContaining({ amount: 1 }),
					}),
				],
			}),
		);
		const accrual2 = await read_accrual(t, fixture);
		expect(accrual2?.fractionalCents ?? 1).toBeLessThan(0.1);
		expect(accrual2).toMatchObject({ lastMeteredDay: "2026-04-11" });

		// Day 3 at the same size accrues another half cent and stays silent again.
		await t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_3_MS });
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
	});

	test("a same-day re-run charges nothing twice", async () => {
		const t = test_convex();
		const fixture = await seed_metered_workspace(t, { storedBytes: 4 * GIB, plan: "Free", clerkUserId: "meter-payer" });
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_plugin_storage_rerun" as never);

		// 4 GiB-days are two cents on the first run.
		await t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_1_MS });
		expect(queued_plugin_storage_events(enqueueActionSpy)).toEqual([
			expect.objectContaining({
				name: "plugin_storage",
				metadata: expect.objectContaining({ amount: 2 }),
			}),
		]);
		const firstEventCount = queued_plugin_storage_events(enqueueActionSpy).length;

		// The second run covers the same UTC day, so it must be a no-op.
		await t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_1_LATER_MS });
		expect(queued_plugin_storage_events(enqueueActionSpy)).toHaveLength(firstEventCount);

		const accrual = await read_accrual(t, fixture);
		expect(accrual?.lastMeteredDay).toBe("2026-04-10");
	});

	test("deleting data lowers the next day's charge instead of refunding", async () => {
		const t = test_convex();
		const fixture = await seed_metered_workspace(t, { storedBytes: 8 * GIB, plan: "Free", clerkUserId: "meter-payer" });
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_plugin_storage_shrink" as never);

		await t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_1_MS });
		vi.mocked(enqueueActionSpy).mockClear();

		await set_stored_bytes(t, { workspaceId: fixture.workspaceId, storedBytes: 2 * GIB });

		// Day 2 bills the shrunk reading: 2 GiB-days are one cent.
		await t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_2_MS });
		expect(enqueueActionSpy).toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.objectContaining({
				events: [
					expect.objectContaining({
						name: "plugin_storage",
						metadata: expect.objectContaining({ amount: 1, storedBytes: 2 * GIB }),
					}),
				],
			}),
		);
	});

	test("reserved bytes count as stored alongside used bytes", async () => {
		const t = test_convex();
		await seed_metered_workspace(t, { storedBytes: 0, reservedBytes: 4 * GIB, plan: null, clerkUserId: "meter-payer" });
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_plugin_storage_reserved" as never);

		await t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_1_MS });
		expect(enqueueActionSpy).toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.objectContaining({
				events: [
					expect.objectContaining({
						name: "plugin_storage",
						metadata: expect.objectContaining({ amount: 2, storedBytes: 4 * GIB }),
					}),
				],
			}),
		);
	});

	test("an organization_owner organization bills its owner, not the actor", async () => {
		const t = test_convex();
		const fixture = await seed_metered_workspace(t, {
			organizationName: "metered-owned-org",
			storedBytes: 4 * GIB,
			plan: "Pro",
		});

		// Switch the organization to owner-billed with an owner other than the seeded member.
		// A Clerk id keeps the owner on the signed-in (Polar) ingest route.
		const ownerId = await t.run(async (ctx) => ctx.db.insert("users", { clerkUserId: "meter-owner" }));
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations", fixture.organizationId, {
				billingMode: "organization_owner",
				ownerUserId: ownerId,
			});
			const now = Date.now();
			await quotas_db_ensure(ctx, { quotaName: "extra_organizations", userId: ownerId, now });
			await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, { userId: ownerId, now });
			await ctx.db.insert("billing_usage_snapshots", {
				userId: ownerId,
				polarCustomerId: `test_customer_${ownerId}`,
				subscription: null,
				meter: null,
				lastSyncedAt: now,
			});
		});
		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_plugin_storage_owner" as never);

		await t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_1_MS });

		// The charge lands on the owner's accrual doc, not the original member's.
		const ownerAccrual = await read_accrual(t, { ...fixture, userId: ownerId });
		expect(ownerAccrual).not.toBeNull();
		const memberAccrual = await read_accrual(t, fixture);
		expect(memberAccrual).toBeNull();
	});

	test("an anonymous payer applies the charge locally to the synthetic snapshot", async () => {
		const t = test_convex();
		const fixture = await seed_metered_workspace(t, { storedBytes: 8 * GIB, plan: "Free" });
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_plugin_storage_anon" as never);

		await t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_1_MS });

		// 8 GiB-days are four cents, applied straight to the synthetic snapshot instead of Polar.
		expect(queued_plugin_storage_events(enqueueActionSpy)).toEqual([]);
		const balanceAfter = await t.run(async (ctx) => {
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", fixture.userId))
				.first();
			return { consumed: snapshot?.meter?.consumedUnits ?? null, balance: snapshot?.meter?.balance ?? null };
		});
		expect(balanceAfter.consumed).toBe(4);
		// The fixture's plan snapshot starts from the setup fixture's flat 100,000-cent balance,
		// not from the plan's recurring credits.
		expect(balanceAfter.balance).toBe(100_000 - 4);

		// The accrual doc still records the covered day, so a replay cannot double-charge.
		const accrual = await read_accrual(t, fixture);
		expect(accrual?.lastMeteredDay).toBe("2026-04-10");
	});

	test("a workspace whose payer has no user doc logs and meters nothing", async () => {
		const t = test_convex();
		const fixture = await seed_metered_workspace(t, { storedBytes: 8 * GIB, plan: null, clerkUserId: "meter-payer" });
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await t.run(async (ctx) => {
			await ctx.db.delete("users", fixture.userId);
		});

		await expect(
			t.mutation(internal.billing_db.meter_plugin_storage_usage, { _test_now: DAY_1_MS }),
		).resolves.toEqual({ processedWorkspaces: 1, emittedEvents: 0 });
		expect(consoleErrorSpy).toHaveBeenCalled();
		expect(await read_accrual(t, fixture)).toBeNull();
	});
});

describe("workspace content purge of billing_usage_accruals", () => {
	test("deletes the workspace's accrual once plugin data is drained", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "accrual-purge-org",
				plan: null,
			}),
		);
		const fixture: MeterFixture = {
			userId: membership.userId,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
		};
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_accruals", {
				billedUserId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				usageKind: "plugin_storage",
				fractionalCents: 0.4,
				lastMeteredDay: "2026-04-10",
				createdAt: now,
				updatedAt: now,
			});
		});
		expect(await read_accrual(t, fixture)).not.toBeNull();

		const requestId = await t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				scope: "workspace",
				eligibleAt: 0,
			}),
		);

		let last: { done: boolean; deletedCount: number } | null = null;
		for (let i = 0; i < 50; i += 1) {
			last = await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
			});
			if (last.done) {
				break;
			}
		}
		expect(last?.done).toBe(true);
		expect(await read_accrual(t, fixture)).toBeNull();
	});
});
