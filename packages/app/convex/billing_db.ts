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
// Keep this a type-only import. `server/billing.ts` loads the Polar SDK at module top level,
// and a value import here would put that ~100ms cold-start cost on every module that imports
// these lean helpers.
import type { billing_Event } from "../server/billing.ts";
import { composite_id } from "../shared/shared-utils.ts";

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

/**
 * Answer whether this user pays for usage at all, for doors that are closed to `Free`.
 *
 * A credit balance cannot answer this. `Free` comes with credits every month, and a door that only
 * looked at the balance would open for a plan that never pays. An anonymous user holds a synthetic
 * snapshot carrying the real Free product id, so this refuses them through the same comparison.
 * No billing state at all means no known plan, which is not a paid one.
 */
export async function billing_db_check_paid_plan(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: Id<"users">;
	},
) {
	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.first();
	if (!usageSnapshot?.subscription) {
		return { hasPaidPlan: false };
	}

	// Same lookup as `billing_polar.getProduct`, without loading the Polar SDK module.
	const product = await ctx.runQuery(components.polar.lib.getProduct, {
		id: usageSnapshot.subscription.productId,
	});
	if (!product) {
		return { hasPaidPlan: false };
	}

	return { hasPaidPlan: product.name !== ("Free" satisfies keyof typeof billing_PRODUCTS) };
}

/**
 * Send the one-cent `file_save` usage event for a file write that just committed.
 * Call it inside the same mutation as the write, after the write succeeded, so a rolled-back
 * write emits nothing and a committed write emits exactly once.
 *
 * The one-cent amount lives here on purpose: this helper is the call site for every public-API
 * write door, so a new door bills the same as the old ones without repeating the number. The four
 * app save doors keep their own inline literal (see the billing-system skill).
 */
export async function billing_db_emit_file_save(
	ctx: MutationCtx,
	args: {
		billedUser: Doc<"users">;
		actorUserId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		/**
		 * Unique per save: a version snapshot asset id or a target id here. See the `file_save`
		 * tuple in `AppCompositeIds` for the collaborative form.
		 */
		version: string;
	},
) {
	// Declare the event against the type instead of calling `billing_event(...)`, so this module
	// never value-imports `server/billing.ts` (see the import note above).
	const event: billing_Event = {
		name: "file_save",
		externalCustomerId: args.billedUser._id,
		externalMemberId: args.actorUserId,
		externalId: composite_id(
			"billing",
			"file_save",
			args.billedUser._id,
			args.actorUserId,
			args.organizationId,
			args.workspaceId,
			args.nodeId,
			args.version,
		),
		metadata: {
			amount: 1,
			actorUserId: args.actorUserId,
			billedUserId: args.billedUser._id,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			version: args.version,
		},
	};

	await billing_ingest_events(ctx, {
		billedUserEvents: [{ billedUser: args.billedUser, event }],
	});
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

