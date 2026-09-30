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
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";

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
 * The one-cent amount lives here on purpose: public workspace-file write doors use this helper.
 * Mount writes use their own event and price. The five
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

export async function billing_db_emit_plugin_volume_file_writes(
	ctx: MutationCtx,
	args: {
		billedUser: Doc<"users">;
		actorUserId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetIds: Id<"files_r2_assets">[];
	},
) {
	// New asset ids make retries unique without sending private paths to Polar.
	const billedUserEvents = args.assetIds.map((assetId) => {
		const event: billing_Event = {
			name: "plugin_volume_file_write",
			externalCustomerId: args.billedUser._id,
			externalMemberId: args.actorUserId,
			externalId: composite_id(
				"billing",
				"plugin_volume_file_write",
				args.billedUser._id,
				args.actorUserId,
				args.organizationId,
				args.workspaceId,
				assetId,
			),
			metadata: {
				amount: 0.5,
				actorUserId: args.actorUserId,
				billedUserId: args.billedUser._id,
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId,
			},
		};
		return { billedUser: args.billedUser, event };
	});
	await billing_ingest_events(ctx, { billedUserEvents });
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
			: "db" in ctx
				? billing_db_ingest_anonymous_user_events(ctx, {
						billedUserEvents: anonymousUserEvents,
					})
				: ctx.runMutation(internal.billing.ingest_anonymous_user_events, {
						billedUserEvents: anonymousUserEvents,
					}),
	]);
}

/**
 * Send one signed-in usage event to Polar through the usage pool. `onComplete` learns when the
 * pool gives up or finishes, so the caller can record the delivery.
 */
export async function billing_db_enqueue_signed_in_event(
	ctx: MutationCtx,
	args: {
		event: billing_Event;
		options: Parameters<typeof billing_workpool_usage_event.enqueueAction>[3];
	},
) {
	await billing_workpool_usage_event.enqueueAction(
		ctx,
		internal.billing.ingest_events,
		{ events: [args.event] },
		args.options,
	);
}

/**
 * Debit an anonymous user's local credit snapshot. Returns `false` when the user has no snapshot
 * with a meter, for example after sign-in deleted it.
 */
export async function billing_db_debit_anonymous_snapshot(
	ctx: MutationCtx,
	args: { userId: Id<"users">; amount: number },
) {
	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.first();
	if (!usageSnapshot || usageSnapshot.meter === null) return false;

	await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
		meter: {
			...usageSnapshot.meter,
			consumedUnits: usageSnapshot.meter.consumedUnits + args.amount,
			balance: usageSnapshot.meter.balance - args.amount,
		},
		lastSyncedAt: Date.now(),
	});
	return true;
}

/**
 * Use the caller's DB context so a mixed Save counts these writes in its budget.
 */
export async function billing_db_ingest_anonymous_user_events(
	ctx: MutationCtx,
	args: { billedUserEvents: Array<{ event: billing_Event; billedUser: Doc<"users"> }> },
) {
	// Several files can bill the same payer in one transaction. Each debit sees the last one.
	for (const { event, billedUser } of args.billedUserEvents) {
		if (billedUser.clerkUserId != null) {
			console.error("Anonymous billing ingest received a signed-in user doc", { billedUserId: billedUser._id, event });
			continue;
		}
		if (event.metadata.amount === 0) continue;
		const debited = await billing_db_debit_anonymous_snapshot(ctx, {
			userId: billedUser._id,
			amount: event.metadata.amount,
		});
		if (!debited) {
			throw should_never_happen("Anonymous user usage snapshot not found or has no meter", {
				userId: billedUser._id,
				event,
			});
		}
	}
}
