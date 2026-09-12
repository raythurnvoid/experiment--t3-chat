import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { test_convex } from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("put", () => {
	test("stores separate values with caller-chosen expiry", async () => {
		const t = test_convex();
		const now = Date.now();
		const shortId = await t.mutation(internal.value_store.put, { value: "cursor", ttl: 1000 });
		const longId = await t.mutation(internal.value_store.put, { value: "cursor", ttl: 2000 });
		const permanentId = await t.mutation(internal.value_store.put, { value: "permanent", ttl: null });

		expect(shortId).not.toBe(longId);
		await expect(t.query(internal.value_store.get, { id: shortId })).resolves.toEqual({
			value: "cursor",
			createdAt: expect.any(Number),
		});
		await t.run(async (ctx) => {
			const values = await ctx.db.query("value_store").collect();
			const metadata = await ctx.db.query("value_store_metadata").collect();
			expect(metadata).toEqual([
				expect.objectContaining({ valueId: shortId, expiresAt: now + 1000 }),
				expect.objectContaining({ valueId: longId, expiresAt: now + 2000 }),
			]);
			expect(values).toEqual([
				expect.objectContaining({ _id: shortId, expiresAt: now + 1000, metadataId: metadata[0]._id }),
				expect.objectContaining({ _id: longId, expiresAt: now + 2000, metadataId: metadata[1]._id }),
				expect.objectContaining({ _id: permanentId, expiresAt: null, metadataId: null }),
			]);
		});
	});

	test.each([-1, NaN, Infinity, -Infinity])("rejects invalid TTL %s without writing", async (ttl) => {
		const t = test_convex();
		await expect(t.mutation(internal.value_store.put, { value: "invalid", ttl })).rejects.toThrow(
			"TTL must be a finite non-negative number or null",
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("value_store").collect()).toEqual([]);
			expect(await ctx.db.query("value_store_metadata").collect()).toEqual([]);
		});
	});

	test("requires an explicit TTL", async () => {
		const t = test_convex();
		// An omitted TTL must fail runtime validation too.
		// @ts-expect-error TTL is required.
		await expect(t.mutation(internal.value_store.put, { value: "missing TTL" })).rejects.toThrow();
	});
});

describe("get", () => {
	test("expires at the chosen deadline without renewing on reads", async () => {
		const t = test_convex();
		const now = Date.now();
		const shortId = await t.mutation(internal.value_store.put, { value: "short", ttl: 1000 });
		const longId = await t.mutation(internal.value_store.put, { value: "long", ttl: 2000 });
		const permanentId = await t.mutation(internal.value_store.put, { value: "permanent", ttl: null });
		const immediateId = await t.mutation(internal.value_store.put, { value: "immediate", ttl: 0 });

		await expect(t.query(internal.value_store.get, { id: immediateId })).resolves.toBeNull();
		vi.setSystemTime(now + 999);
		expect((await t.query(internal.value_store.get, { id: shortId }))?.value).toBe("short");
		vi.setSystemTime(now + 1000);
		await expect(t.query(internal.value_store.get, { id: shortId })).resolves.toBeNull();
		expect((await t.query(internal.value_store.get, { id: longId }))?.value).toBe("long");
		vi.setSystemTime(now + 2000);
		await expect(t.query(internal.value_store.get, { id: longId })).resolves.toBeNull();
		vi.setSystemTime(now + 365 * 24 * 60 * 60 * 1000);
		expect((await t.query(internal.value_store.get, { id: permanentId }))?.value).toBe("permanent");
		// Expiry rejects reads before the daily cleanup removes the doc.
		expect(await t.run((ctx) => ctx.db.get("value_store", shortId))).not.toBeNull();
	});

	test("returns null for malformed and removed IDs", async () => {
		const t = test_convex();
		const id = await t.mutation(internal.value_store.put, { value: "removed", ttl: null });
		await t.mutation(internal.value_store.remove, { id });
		await expect(t.query(internal.value_store.get, { id: "not-a-convex-id" })).resolves.toBeNull();
		await expect(t.query(internal.value_store.get, { id })).resolves.toBeNull();
	});
});

describe("remove", () => {
	test.each([1000, null])("removes a value with TTL %s and its metadata only once", async (ttl) => {
		const t = test_convex();
		const id = await t.mutation(internal.value_store.put, { value: "removed", ttl });
		await t.mutation(internal.value_store.remove, { id });
		await t.mutation(internal.value_store.remove, { id });
		await expect(t.query(internal.value_store.get, { id })).resolves.toBeNull();
		await t.run(async (ctx) => {
			expect(await ctx.db.query("value_store").collect()).toEqual([]);
			expect(await ctx.db.query("value_store_metadata").collect()).toEqual([]);
		});
	});
});

describe("cleanup_expired", () => {
	test("removes large expired values in batches and keeps the first cutoff", async () => {
		const t = test_convex({ transactionLimits: true });
		const now = Date.now();
		const value = "x".repeat(1000 * 1024);
		for (let index = 0; index < 21; index++) {
			await t.mutation(internal.value_store.put, { value, ttl: 1000 });
		}
		const futureId = await t.mutation(internal.value_store.put, { value: "future", ttl: 2000 });
		const permanentId = await t.mutation(internal.value_store.put, { value: "permanent", ttl: null });
		vi.setSystemTime(now + 1000);
		const firstBatch = await t.mutation(internal.value_store.cleanup_expired, {});
		expect(firstBatch).toEqual({ deletedCount: 10, done: false });

		// A value that expires later stays until the next cleanup starts.
		vi.setSystemTime(now + 1001);
		const laterId = await t.mutation(internal.value_store.put, { value: "later", ttl: 0 });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await t.run(async (ctx) => {
			const values = await ctx.db.query("value_store").collect();
			expect(values.map((doc) => doc._id).sort()).toEqual([futureId, permanentId, laterId].sort());
			const metadata = await ctx.db.query("value_store_metadata").collect();
			expect(metadata.map((doc) => doc.valueId).sort()).toEqual([futureId, laterId].sort());
		});
		await expect(t.mutation(internal.value_store.cleanup_expired, {})).resolves.toEqual({
			deletedCount: 1,
			done: true,
		});
	});
});

describe("remove_all", () => {
	test("removes large values with and without expiry while keeping newer writes", async () => {
		const t = test_convex({ transactionLimits: true });
		const now = Date.now();
		const value = "x".repeat(1000 * 1024);
		for (let index = 0; index < 11; index++) {
			await t.mutation(internal.value_store.put, { value, ttl: index % 2 ? 1000 : null });
		}
		vi.setSystemTime(now + 100);
		const firstBatch = await t.mutation(internal.value_store.remove_all, {});
		expect(firstBatch).toEqual({ deletedCount: 5, done: false });

		vi.setSystemTime(now + 101);
		const newId = await t.mutation(internal.value_store.put, { value: "new", ttl: 1000 });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await t.run(async (ctx) => {
			const values = await ctx.db.query("value_store").collect();
			expect(values.map((doc) => doc._id)).toEqual([newId]);
			const metadata = await ctx.db.query("value_store_metadata").collect();
			expect(metadata.map((doc) => doc.valueId)).toEqual([newId]);
		});
		await expect(t.mutation(internal.value_store.remove_all, { before: now + 100 })).resolves.toEqual({
			deletedCount: 0,
			done: true,
		});
		expect((await t.query(internal.value_store.get, { id: newId }))?.value).toBe("new");
	});
});
