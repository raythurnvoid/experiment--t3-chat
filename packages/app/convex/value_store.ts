import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";

// Reuse the V8 context between invocations to skip the module-eval tax (same flag as
// files_nodes.ts — see the comment there; no mutable module-level state allowed here).
export const experimental_reuseContext = true;

const VALUE_STORE_TTL_MS = 24 * 60 * 60 * 1000;
const VALUE_STORE_CLEANUP_BATCH_SIZE = 1000;

export const put = internalMutation({
	args: {
		value: v.string(),
	},
	returns: v.id("value_store"),
	handler: async (ctx, args) => {
		return await ctx.db.insert("value_store", {
			value: args.value,
		});
	},
});

export const get = internalQuery({
	args: {
		id: v.string(),
		_test_now: v.optional(v.number()),
	},
	returns: v.union(
		v.object({
			value: v.string(),
			createdAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const id = ctx.db.normalizeId("value_store", args.id);
		if (!id) {
			return null;
		}

		const doc = await ctx.db.get("value_store", id);
		if (!doc) {
			return null;
		}

		const now = args._test_now ?? Date.now();
		if (doc._creationTime < now - VALUE_STORE_TTL_MS) {
			return null;
		}

		return {
			value: doc.value,
			createdAt: doc._creationTime,
		};
	},
});

export const cleanup_expired = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	returns: v.object({
		deletedCount: v.number(),
	}),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const cutoff = now - VALUE_STORE_TTL_MS;
		const limit =
			typeof args.limit === "number" && Number.isFinite(args.limit)
				? Math.max(1, Math.min(VALUE_STORE_CLEANUP_BATCH_SIZE, Math.trunc(args.limit)))
				: VALUE_STORE_CLEANUP_BATCH_SIZE;
		const expired = await ctx.db
			.query("value_store")
			.withIndex("by_creation_time", (q) => q.lte("_creationTime", cutoff))
			.order("asc")
			.take(limit);

		await Promise.all(expired.map((doc) => ctx.db.delete("value_store", doc._id)));

		return {
			deletedCount: expired.length,
		};
	},
});

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest;

	describe("value_store", () => {
		test("stores and retrieves a value", async () => {
			const { test_convex } = await import("./setup.test.ts");
			const { internal } = await import("./_generated/api.js");
			const t = test_convex();

			const id = await t.mutation(internal.value_store.put, { value: "cursor-value" });
			const result = await t.query(internal.value_store.get, { id });

			expect(result).toMatchObject({
				value: "cursor-value",
			});
			expect(result?.createdAt).toEqual(expect.any(Number));
		});

		test("returns null for malformed, missing, and expired ids", async () => {
			const { test_convex } = await import("./setup.test.ts");
			const { internal } = await import("./_generated/api.js");
			const t = test_convex();

			const id = await t.mutation(internal.value_store.put, { value: "cursor-value" });
			await t.run(async (ctx) => {
				await ctx.db.delete("value_store", id);
			});

			await expect(t.query(internal.value_store.get, { id: "not-a-convex-id" })).resolves.toBeNull();
			await expect(t.query(internal.value_store.get, { id })).resolves.toBeNull();

			const expiredId = await t.mutation(internal.value_store.put, { value: "expired" });
			const expiredCreatedAt = await t.run(async (ctx) => {
				const doc = await ctx.db.get("value_store", expiredId);
				if (!doc) {
					throw new Error("expected value_store row");
				}
				return doc._creationTime;
			});
			await expect(
				t.query(internal.value_store.get, {
					id: expiredId,
					_test_now: expiredCreatedAt + VALUE_STORE_TTL_MS + 1,
				}),
			).resolves.toBeNull();
		});

		test("cleanup_expired deletes old rows and keeps fresh rows", async () => {
			const { test_convex } = await import("./setup.test.ts");
			const { internal } = await import("./_generated/api.js");
			const t = test_convex();

			const freshId = await t.mutation(internal.value_store.put, { value: "fresh" });
			const freshCreatedAt = await t.run(async (ctx) => {
				const doc = await ctx.db.get("value_store", freshId);
				if (!doc) {
					throw new Error("expected value_store row");
				}
				return doc._creationTime;
			});
			const freshCleanup = await t.mutation(internal.value_store.cleanup_expired, {
				_test_now: freshCreatedAt + VALUE_STORE_TTL_MS - 1,
			});
			const stillFresh = await t.query(internal.value_store.get, { id: freshId });

			expect(freshCleanup.deletedCount).toBe(0);
			expect(stillFresh?.value).toBe("fresh");

			const expiredCleanup = await t.mutation(internal.value_store.cleanup_expired, {
				_test_now: freshCreatedAt + VALUE_STORE_TTL_MS + 1,
			});
			const expired = await t.query(internal.value_store.get, { id: freshId });

			expect(expiredCleanup.deletedCount).toBe(1);
			expect(expired).toBeNull();
		});
	});
}
