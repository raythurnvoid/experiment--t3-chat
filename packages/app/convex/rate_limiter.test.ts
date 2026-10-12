import { afterEach, describe, expect, test, vi } from "vitest";
import { getFunctionAddress } from "convex/server";
import { components } from "./_generated/api.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import { rate_limiter_get_plugin_volume_daily_files_left, rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { test_convex } from "./setup-base.test.ts";

afterEach(() => {
	vi.restoreAllMocks();
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
		// A mutation ctx must rethrow, so Convex reruns the whole mutation.
		const mutationCtx = { db: {}, runMutation: () => Promise.reject(conflict) } as unknown as MutationCtx;
		await expect(
			rate_limiter_limit_by_key(mutationCtx, { name: "public_api_principal", key: "user_api_key:k" }),
		).rejects.toThrow("changed while this mutation was being run");
	});

	test("allows 20 calls from every start part and keeps keys separate", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const random = vi.spyOn(Math, "random");
		const t = test_convex();
		for (const start of [0, 0.5, 0.999]) {
			random.mockReturnValue(start);
			const key = `principal:${start}`;
			for (let call = 0; call < 20; call += 1) {
				expect(
					await t.run((ctx) => rate_limiter_limit_by_key(ctx, { name: "public_api_principal", key })),
					`call ${call + 1} from start ${start}`,
				).toBeNull();
			}
			expect(await t.run((ctx) => rate_limiter_limit_by_key(ctx, { name: "public_api_principal", key }))).toEqual({
				message: "Rate limit exceeded",
				retryAfterMs: 2_000,
			});
		}
	});

	test("an action charges the principal bucket in one parent mutation", async () => {
		const runMutation = vi.fn().mockResolvedValue({ ok: false, retryAfter: 2_000 });
		const ctx = { runMutation } as unknown as ActionCtx;
		expect(await rate_limiter_limit_by_key(ctx, { name: "public_api_principal", key: "principal:k" })).toEqual({
			message: "Rate limit exceeded",
			retryAfterMs: 2_000,
		});
		expect(runMutation).toHaveBeenCalledTimes(1);
		expect(getFunctionAddress(runMutation.mock.calls[0]![0])).toEqual({ name: "rate_limiter:limit_principal" });
		expect(runMutation.mock.calls[0]![1]).toEqual({ key: "principal:k" });
	});

	test("returns the smallest wait after every part refuses", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.spyOn(Math, "random").mockReturnValue(0.999);
		const now = Date.now();
		const t = test_convex();
		for (let part = 0; part < 4; part += 1) {
			vi.setSystemTime(now - (3 - part) * 500);
			expect(
				await t.mutation(components.rate_limiter.lib.rateLimit, {
					name: "public_api_principal",
					key: `principal:wait:${part}`,
					config: { kind: "token bucket", rate: 30, period: 60_000, capacity: 5 },
					count: 5,
				}),
			).toEqual({ ok: true });
		}
		vi.setSystemTime(now);
		expect(
			await t.run((ctx) => rate_limiter_limit_by_key(ctx, { name: "public_api_principal", key: "principal:wait" })),
		).toEqual({ message: "Rate limit exceeded", retryAfterMs: 500 });
	});

	test("rejects a principal count above 1 before charging", async () => {
		const t = test_convex();
		for (const count of [undefined, 1]) {
			expect(
				await t.run((ctx) =>
					rate_limiter_limit_by_key(ctx, { name: "public_api_principal", key: "principal:count", count }),
				),
			).toBeNull();
		}
		const runMutation = vi.fn().mockResolvedValue({ ok: true });
		const ctx = { runMutation } as unknown as ActionCtx;
		await expect(
			rate_limiter_limit_by_key(ctx, { name: "public_api_principal", key: "principal:count", count: 2 }),
		).rejects.toThrow("Principal rate limit charge must be 1");
		expect(runMutation).toHaveBeenCalledTimes(0);
	});

	test("keeps partial tokens in their parts and refills four whole tokens after two seconds", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const now = Date.now();
		const t = test_convex();
		const charge = () =>
			t.run((ctx) => rate_limiter_limit_by_key(ctx, { name: "public_api_principal", key: "principal:refill" }));
		for (let call = 0; call < 20; call += 1) expect(await charge()).toBeNull();
		vi.setSystemTime(now + 1_000);
		expect(await charge()).toEqual({ message: "Rate limit exceeded", retryAfterMs: 1_000 });
		vi.setSystemTime(now + 2_000);
		for (let call = 0; call < 4; call += 1) expect(await charge()).toBeNull();
		expect(await charge()).toEqual({ message: "Rate limit exceeded", retryAfterMs: 2_000 });
	});

	test("keeps the sharded bulk charge limit", async () => {
		const t = test_convex();
		// A config check: the limiter names the shard count when a charge is too big for it.
		await expect(
			t.run((ctx) => rate_limiter_limit_by_key(ctx, { name: "public_api_files_write_bulk", key: "k", count: 51 })),
		).rejects.toThrow("exceeds 50 per 4 shards");
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
