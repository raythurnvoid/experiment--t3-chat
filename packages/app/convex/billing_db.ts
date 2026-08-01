// Lean billing helpers for modules that only check credits or enqueue usage events.
//
// Lives outside `billing.ts` because that module imports `@convex-dev/polar` and the Polar SDK,
// which cost ~100ms of module evaluation on every cold Convex call. File mutations that bill
// saves (yjs pushes, snapshot restores, pending updates) import this module instead, and the
// Polar product lookup goes through the generated component reference directly.

import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { type billing_Event } from "../server/billing.ts";

const billing_workpool_usage_event = new Workpool(components.billing_workpool_usage_event, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 10 * 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

export function billing_pick_billed_user_id(args: {
	userId: Id<"users">;
	organization: Pick<Doc<"organizations">, "default" | "billingMode" | "ownerUserId">;
}) {
	if (!args.organization.default && args.organization.billingMode === "organization_owner")
		return args.organization.ownerUserId;
	return args.userId;
}

export async function billing_db_check_credits(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: Id<"users">;
		minimumRequiredCents: number;
	},
) {
	const hasCredits = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.first()
		.then(async (usageSnapshot) => {
			if (!usageSnapshot?.subscription) {
				return false;
			}

			// Same lookup as `billing_polar.getProduct`, without loading the Polar SDK module.
			const product = await ctx.runQuery(components.polar.lib.getProduct, {
				id: usageSnapshot.subscription.productId,
			});
			if (!product) return false;

			const meterBalanceCents = usageSnapshot.meter?.balance ?? 0;

			if (
				product.name === ("Free" satisfies keyof typeof billing_PRODUCTS) &&
				meterBalanceCents < args.minimumRequiredCents
			) {
				return false;
			}

			return true;
		});

	return { hasCredits };
}

/** Route app-owned billing events by billed user row: Polar for signed-in payers, local snapshot updates for anonymous payers. */
export async function billing_ingest_events(
	ctx: ActionCtx | MutationCtx,
	args: {
		billedUserEvents: Array<{
			event: billing_Event;
			billedUser: Doc<"users">;
		}>;
	},
) {
	const anonymousUserEvents: typeof args.billedUserEvents = [];
	const signedInEvents: Array<billing_Event> = [];

	for (const userEvent of args.billedUserEvents) {
		if (userEvent.billedUser.clerkUserId == null) {
			anonymousUserEvents.push(userEvent);
			continue;
		}

		signedInEvents.push(userEvent.event);
	}

	await Promise.all([
		signedInEvents.length === 0
			? Promise.resolve()
			: billing_workpool_usage_event.enqueueAction(ctx, internal.billing.ingest_events, {
					events: signedInEvents,
				}),
		anonymousUserEvents.length === 0
			? Promise.resolve()
			: ctx.runMutation(internal.billing.ingest_anonymous_user_events, {
					billedUserEvents: anonymousUserEvents,
				}),
	]);
}
