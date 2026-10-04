import { afterEach, describe, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";
import { internal } from "./_generated/api.js";
import {
	files_stored_uploads_cost_cents,
	files_stored_uploads_db_admit,
	files_stored_uploads_db_settle,
} from "./files_stored_uploads.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

afterEach(() => vi.restoreAllMocks());

describe("files_stored_uploads_cost_cents", () => {
	test.each([
		[0, 1],
		[1, 1],
		[20 * 1024 * 1024, 1],
		[20 * 1024 * 1024 + 1, 2],
		[2 * 1024 * 1024 * 1024, 103],
	])("charges %i bytes at %i cents", (bytes, cents) => {
		expect(files_stored_uploads_cost_cents(bytes)).toBe(cents);
	});
});

describe("files_stored_uploads_db_admit", () => {
	test.each(["Free", null] as const)("refuses %s before creating a stored-file quota", async (plan) => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { plan }));
		const before = await t.run((ctx) => ctx.db.query("quotas").collect());
		const result = await t.run(async (ctx) => {
			const organization = await ctx.db.get("organizations", db.organizationId);
			if (!organization) throw new Error("Expected organization");
			return await files_stored_uploads_db_admit(ctx, {
				organization,
				actorUserId: db.userId,
				workspaceId: db.workspaceId,
				declaredBytes: [10],
			});
		});
		expect(result._nay?.name).toBe("plan_required");
		expect(await t.run((ctx) => ctx.db.query("quotas").collect())).toEqual(before);
	});

	test.each([-1, NaN, Infinity, 0.5, 2 * 1024 * 1024 * 1024 + 1])(
		"refuses invalid %s bytes in a batch without changing quotas",
		async (bytes) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const before = await t.run((ctx) => ctx.db.query("quotas").collect());
			const result = await t.run(async (ctx) => {
				const organization = await ctx.db.get("organizations", db.organizationId);
				if (!organization) throw new Error("Expected organization");
				return await files_stored_uploads_db_admit(ctx, {
					organization,
					actorUserId: db.userId,
					workspaceId: db.workspaceId,
					declaredBytes: [20, bytes],
				});
			});
			expect(result._nay?.name).toBe("file_too_large");
			expect(await t.run((ctx) => ctx.db.query("quotas").collect())).toEqual(before);
		},
	);

	test("admits a paid batch without seeding or consuming the quota", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const before = await t.run((ctx) => ctx.db.query("quotas").collect());
		const result = await t.run(async (ctx) => {
			const organization = await ctx.db.get("organizations", db.organizationId);
			if (!organization) throw new Error("Expected organization");
			return await files_stored_uploads_db_admit(ctx, {
				organization,
				actorUserId: db.userId,
				workspaceId: db.workspaceId,
				declaredBytes: [0, 10, 2 * 1024 * 1024 * 1024],
			});
		});
		expect(result._yay).toEqual({ billedUserId: db.userId });
		expect(await t.run((ctx) => ctx.db.query("quotas").collect())).toEqual(before);
	});

	test("uses the owner's plan and keeps a trusted copy payer pin", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => {
			const actorUserId = await ctx.db.insert("users", { clerkUserId: null });
			await test_mocks_fill_db_with.plan(ctx, { userId: actorUserId, plan: "Free" });
			await ctx.db.patch("organizations", db.organizationId, { billingMode: "organization_owner" });
			const organization = await ctx.db.get("organizations", db.organizationId);
			if (!organization) throw new Error("Expected organization");
			const args = { organization, actorUserId, workspaceId: db.workspaceId, declaredBytes: [10] };
			expect((await files_stored_uploads_db_admit(ctx, args))._yay).toEqual({ billedUserId: db.userId });
			expect((await files_stored_uploads_db_admit(ctx, { ...args, billedUserId: actorUserId }))._nay?.name).toBe(
				"plan_required",
			);
		});
	});

	test("checks the whole batch against the stored ceiling without consuming it", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => {
			const quotaId = await quotas_db_ensure(ctx, { ...db, quotaName: "stored_file_bytes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { maxCount: 30, usedCount: 10 });
			const organization = await ctx.db.get("organizations", db.organizationId);
			if (!organization) throw new Error("Expected organization");
			const before = await ctx.db.get("quotas", quotaId);
			const args = { organization, actorUserId: db.userId, workspaceId: db.workspaceId };
			expect((await files_stored_uploads_db_admit(ctx, { ...args, declaredBytes: [10, 10] }))._yay).toBeTruthy();
			expect((await files_stored_uploads_db_admit(ctx, { ...args, declaredBytes: [10, 11] }))._nay).toEqual({
				name: "storage_full",
				message: "This workspace has reached its storage limit",
			});
			expect(await ctx.db.get("quotas", quotaId)).toEqual(before);
		});
	});
});

describe("files_stored_uploads_db_settle", () => {
	test.each([true, false])("refuses oversized bytes before counting or billing, chargeable=%s", async (chargeable) => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_upload" as never);
		await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				...{ organizationId: db.organizationId, workspaceId: db.workspaceId },
				kind: "upload",
				r2Bucket: "test",
				size: 10,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			const before = await ctx.db.query("quotas").collect();
			const snapshotBefore = await ctx.db.query("billing_usage_snapshots").collect();
			expect(
				(
					await files_stored_uploads_db_settle(ctx, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						assetId,
						declaredBytes: 10,
						actualBytes: 11,
						actorUserId: db.userId,
						billedUserId: db.userId,
						nodeId: null,
						chargeKey: assetId,
						chargeable,
					})
				)._nay?.name,
			).toBe("larger_than_declared");
			expect(await ctx.db.query("quotas").collect()).toEqual(before);
			expect(await ctx.db.query("billing_usage_snapshots").collect()).toEqual(snapshotBefore);
		});
		expect(enqueue).not.toHaveBeenCalled();
	});

	test.each([true, false])(
		"counts real bytes past the cap and bills the exact amount, signed-in=%s",
		async (signedIn) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_upload" as never);
			const bytes = 20 * 1024 * 1024 + 1;
			const assetId = await t.run(async (ctx) => {
				if (signedIn) await ctx.db.patch("users", db.userId, { clerkUserId: "clerk_upload_payer" });
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "upload",
					r2Bucket: "test",
					size: bytes + 10,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				const quotaId = await quotas_db_ensure(ctx, { ...db, quotaName: "stored_file_bytes", now: Date.now() });
				await ctx.db.patch("quotas", quotaId, { maxCount: 10, usedCount: 10 });
				expect(
					await files_stored_uploads_db_settle(ctx, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						assetId,
						declaredBytes: bytes + 10,
						actualBytes: bytes,
						actorUserId: db.userId,
						billedUserId: db.userId,
						nodeId: null,
						chargeKey: "target_charge_key",
						chargeable: true,
					}),
				).toEqual({ _yay: null });
				expect((await ctx.db.get("quotas", quotaId))?.usedCount).toBe(10 + bytes);
				const snapshot = await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", db.userId))
					.first();
				expect(snapshot?.meter?.consumedUnits).toBe(signedIn ? 0 : 2);
				return assetId;
			});
			if (!signedIn) {
				expect(enqueue).not.toHaveBeenCalled();
				return;
			}
			expect(enqueue).toHaveBeenCalledTimes(1);
			expect(enqueue).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
				events: [
					{
						name: "file_upload",
						externalCustomerId: db.userId,
						externalMemberId: db.userId,
						externalId: `file_upload::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::target_charge_key`,
						metadata: {
							amount: 2,
							actorUserId: db.userId,
							billedUserId: db.userId,
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							nodeId: null,
							assetId,
							bytes,
						},
					},
				],
			});
		},
	);

	test("leaves exempt imports outside the counter and billing", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_upload" as never);
		await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "upload",
				r2Bucket: "test",
				size: 10,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			const before = await ctx.db.query("quotas").collect();
			const snapshotBefore = await ctx.db.query("billing_usage_snapshots").collect();
			expect(
				await files_stored_uploads_db_settle(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					assetId,
					declaredBytes: 10,
					actualBytes: 10,
					actorUserId: db.userId,
					billedUserId: db.userId,
					nodeId: null,
					chargeKey: assetId,
					chargeable: false,
				}),
			).toEqual({ _yay: null });
			expect(await ctx.db.query("quotas").collect()).toEqual(before);
			expect(await ctx.db.query("billing_usage_snapshots").collect()).toEqual(snapshotBefore);
		});
		expect(enqueue).not.toHaveBeenCalled();
	});
});
