import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.resetModules();
});

// The webhook URL is read once at module load, so each test stubs the env and resets the registry
// before the action loads the module.
function use_webhook_url(url: string | undefined) {
	vi.stubEnv("BILLING_ALERT_WEBHOOK_URL", url);
	vi.resetModules();
}

async function seed_rejected_events(t: ReturnType<typeof test_convex>, rejectedAts: number[]) {
	await t.run(async (ctx) => {
		const db = await test_mocks_fill_db_with.membership(ctx);
		for (const [index, rejectedAt] of rejectedAts.entries()) {
			await ctx.db.insert("billing_usage_event_rejected", {
				event: {
					name: "manual_credit",
					externalCustomerId: db.userId,
					externalId: `manual_credit::${db.userId}::${index}`,
					metadata: { amount: 1 },
				},
				error: "Polar refused it",
				rejectedAt,
			});
		}
	});
}

describe("check_usage_event_backlog", () => {
	test("posts counts and times, with no names or ids, when Polar refused events and the outbox is stuck", async () => {
		use_webhook_url("https://alerts.test/billing");
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const t = test_convex();
		await seed_rejected_events(t, [1000, 2000]);
		const outboxEvent = await t.run(async (ctx) => {
			const event = (await ctx.db.query("billing_usage_event_rejected").first())!.event;
			return await ctx.db.get(
				"billing_usage_event_outbox",
				await ctx.db.insert("billing_usage_event_outbox", { event }),
			);
		});
		const stuckOutboxSince = outboxEvent!._creationTime;
		vi.spyOn(Date, "now").mockReturnValue(Math.ceil(stuckOutboxSince) + 11 * 60 * 1000);

		await t.action(internal.billing_alerts.check_usage_event_backlog, {});

		expect(fetchMock, "the alert must reach the webhook").toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith("https://alerts.test/billing", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ count: 2, oldestRejectedAt: 1000, stuckOutboxSince }),
		});
	});

	test("only logs without a webhook URL, and stays quiet with no backlog", async () => {
		use_webhook_url(undefined);
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const t = test_convex();

		await t.action(internal.billing_alerts.check_usage_event_backlog, {});
		expect(consoleError).not.toHaveBeenCalled();

		// A young outbox event is normal; only refused events alert.
		await seed_rejected_events(t, [5000]);
		await t.action(internal.billing_alerts.check_usage_event_backlog, {});
		expect(consoleError).toHaveBeenCalledWith("Billing usage events need attention", {
			count: 1,
			oldestRejectedAt: 5000,
			stuckOutboxSince: null,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
