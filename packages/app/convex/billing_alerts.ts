// Daily alert for billing usage events that wait too long. See "Usage event outbox" in the
// billing-system skill.

import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction, internalQuery } from "./_generated/server.js";

/**
 * Optional. Without it, the alert only goes to the logs.
 */
const BILLING_ALERT_WEBHOOK_URL = process.env.BILLING_ALERT_WEBHOOK_URL;

/**
 * The check reads at most this many refused events, so `count` 1000 means 1000 or more.
 */
const REJECTED_COUNT_LIMIT = 1000;

/**
 * The drainer sends an event within seconds, and recovery restarts a stopped chain within 10
 * minutes. An older event means the drainer is stuck.
 */
const OUTBOX_STUCK_MS = 10 * 60 * 1000;

export const read_usage_event_backlog = internalQuery({
	args: {},
	returns: v.object({
		count: v.number(),
		oldestRejectedAt: v.union(v.number(), v.null()),
		oldestOutboxEventAt: v.union(v.number(), v.null()),
	}),
	handler: async (ctx) => {
		const rejected = await ctx.db.query("billing_usage_event_rejected").take(REJECTED_COUNT_LIMIT);
		const oldestOutboxEvent = await ctx.db.query("billing_usage_event_outbox").first();
		return {
			count: rejected.length,
			oldestRejectedAt: rejected[0]?.rejectedAt ?? null,
			oldestOutboxEventAt: oldestOutboxEvent?._creationTime ?? null,
		};
	},
});

/**
 * Alert when Polar refused events (`billing_usage_event_rejected`) or the outbox has an event older
 * than 10 minutes. It sends counts and times only, no names or ids.
 */
export const check_usage_event_backlog = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const backlog = await ctx.runQuery(internal.billing_alerts.read_usage_event_backlog, {});
		const stuckOutboxSince =
			backlog.oldestOutboxEventAt !== null && backlog.oldestOutboxEventAt < Date.now() - OUTBOX_STUCK_MS
				? backlog.oldestOutboxEventAt
				: null;
		if (backlog.count === 0 && stuckOutboxSince === null) return null;

		const alert = { count: backlog.count, oldestRejectedAt: backlog.oldestRejectedAt, stuckOutboxSince };
		console.error("Billing usage events need attention", alert);
		if (!BILLING_ALERT_WEBHOOK_URL) return null;

		const response = await fetch(BILLING_ALERT_WEBHOOK_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(alert),
		});
		if (!response.ok) console.error("Billing alert webhook failed", { status: response.status });
		return null;
	},
});
