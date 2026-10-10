import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "./_generated/server.js";
import { rate_limiter_get_plugin_volume_daily_files_left, rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { test_convex } from "./setup.test.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("rate_limiter_limit_by_key", () => {
	test("turns a write conflict seen by an action into a 429 answer", async () => {
		// The exact text from the Convex backend, `crates/errors/src/lib.rs:378-382`.
		const conflict = new Error(
			'Documents read from or written to the "rateLimits" table changed while this mutation was being run and on every subsequent retry. See https://docs.convex.dev/error#1',
		);
		const actionCtx = (error: Error) =>
			({
				runMutation: () => Promise.reject(error),
			}) as unknown as ActionCtx;

		expect(
			await rate_limiter_limit_by_key(actionCtx(conflict), { name: "public_api_principal", key: "user_api_key:k" }),
		).toEqual({ message: "Rate limit exceeded", retryAfterMs: 1000 });
		await expect(
			rate_limiter_limit_by_key(actionCtx(new Error("boom")), { name: "public_api_principal", key: "user_api_key:k" }),
		).rejects.toThrow("boom");
	});

	test("public API buckets are sharded and every batch charge fits", async () => {
		const t = test_convex();
		// A config check: the limiter names the shard count when a charge is too big for it.
		await expect(
			t.run((ctx) => rate_limiter_limit_by_key(ctx, { name: "public_api_principal", key: "k", count: 11 })),
		).rejects.toThrow("exceeds 10 per 4 shards");
		await expect(
			t.run((ctx) => rate_limiter_limit_by_key(ctx, { name: "public_api_files_write_bulk", key: "k", count: 51 })),
		).rejects.toThrow("exceeds 50 per 4 shards");
		// The largest write-many batch fits one charge on a fresh key.
		expect(
			await t.run((ctx) =>
				rate_limiter_limit_by_key(ctx, { name: "public_api_files_write_bulk", key: "k", count: 20 }),
			),
		).toBeNull();
	});
});

describe("rate_limiter_get_plugin_volume_daily_files_left", () => {
	test("uses the supplied clock to reset saved tokens at UTC midnight", async () => {
		vi.useFakeTimers();
		const now = Date.parse("2026-09-28T23:59:59Z");
		vi.setSystemTime(now);
		const t = test_convex();
		const key = "organization:workspace:source-plugin";
		expect(
			await t.run((ctx) =>
				rate_limiter_limit_by_key(ctx, { name: "plugins_volume_daily_files", key, count: 10_000 }),
			),
		).toBeNull();
		expect(await t.run((ctx) => rate_limiter_get_plugin_volume_daily_files_left(ctx, { key, now }))).toBe(0);
		// Keep the process clock old, like a cached query result, and pass the next day's clock.
		expect(
			await t.run((ctx) => rate_limiter_get_plugin_volume_daily_files_left(ctx, { key, now: now + 1_000 })),
		).toBe(10_000);
	});

	test("keeps separate plugin keys within one workspace", async () => {
		const t = test_convex();
		const key = "organization:workspace:source-plugin";
		await t.run((ctx) => rate_limiter_limit_by_key(ctx, { name: "plugins_volume_daily_files", key, count: 35 }));
		expect(await t.run((ctx) => rate_limiter_get_plugin_volume_daily_files_left(ctx, { key, now: Date.now() }))).toBe(
			9_965,
		);
		expect(
			await t.run((ctx) =>
				rate_limiter_get_plugin_volume_daily_files_left(ctx, {
					key: "organization:workspace:records-plugin",
					now: Date.now(),
				}),
			),
		).toBe(10_000);
	});
});
