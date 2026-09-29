import { afterEach, describe, expect, test, vi } from "vitest";
import { rate_limiter_get_plugin_volume_daily_files_left, rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { test_convex } from "./setup.test.ts";

afterEach(() => {
	vi.useRealTimers();
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
