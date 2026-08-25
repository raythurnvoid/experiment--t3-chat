// Lean billing helpers for modules that only check credits or enqueue usage events.
//
// Lives outside `billing.ts` because that module imports `@convex-dev/polar` and the Polar SDK,
// which cost ~100ms of module evaluation on every cold Convex call. File mutations that bill
// saves (yjs pushes, snapshot restores, pending updates) import this module instead, and the
// Polar product lookup goes through the generated component reference directly.

import { Workpool } from "@convex-dev/workpool";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { billing_event, type billing_Event } from "../server/billing.ts";
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

// #region metered plugin storage

/**
 * Price of one stored byte for one day, in cents.
 *
 * About €0.15 per GiB-month. A placeholder like the chat token rates: a real
 * price is a product decision that should compare R2 and Convex storage cost
 * before GA.
 */
const PLUGIN_STORAGE_CENTS_PER_BYTE_DAY = 15 / (1024 * 1024 * 1024) / 30;

/** UTC day string (`YYYY-MM-DD`) covering `ms`. */
function utc_day_of(ms: number) {
	return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Turn each workspace's stored plugin-data bytes into accrued cents, and emit a
 * whole-cent Polar charge once enough has built up.
 *
 * The pass reads the stored-bytes counters instead of billing writes, so deleting
 * plugin documents today simply lowers tomorrow's reading — no refund events, and no
 * per-write cost inside any write door. Sub-cent remainders carry forward on the
 * accrual doc until a whole cent can be charged. `lastMeteredDay` makes a
 * same-day re-run a no-op.
 *
 * Reads every installation accounting doc in one pass. The set is naturally
 * small — one doc per installed plugin per workspace, maintained
 * transactionally by writes — so collecting beats pagination machinery for a
 * daily job.
 */
export const meter_plugin_storage_usage = internalMutation({
	args: {
		/** Test seam: pins "now" so tests get deterministic UTC days. */
		_test_now: v.optional(v.number()),
	},
	returns: v.object({ processedWorkspaces: v.number(), emittedEvents: v.number() }),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const day = utc_day_of(now);

		const scopes = new Map<string, { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> }>();
		for await (const usage of ctx.db.query("plugins_data_usage")) {
			scopes.set(`${usage.organizationId}:${usage.workspaceId}`, {
				organizationId: usage.organizationId,
				workspaceId: usage.workspaceId,
			});
		}

		let emittedEvents = 0;
		for (const scope of scopes.values()) {
			emittedEvents += await meter_one_workspace(ctx, { ...scope, day, now });
		}

		return { processedWorkspaces: scopes.size, emittedEvents };
	},
});

/**
 * Meter one workspace's stored plugin-data bytes against its payer.
 *
 * The whole workspace sums into one reading and one accrual doc, so its payer
 * gets one charge rather than one per installed plugin.
 */
async function meter_one_workspace(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		day: string;
		now: number;
	},
): Promise<number> {
	const organization = await ctx.db.get("organizations", args.organizationId);
	if (!organization) {
		// Teardown deletes accounting docs before the organization doc, so a missing
		// org here means deletion already passed this workspace. Nothing left to bill.
		return 0;
	}
	const billedUserId = billing_pick_billed_user_id({ userId: organization.ownerUserId, organization });

	const billedUser = await ctx.db.get("users", billedUserId);
	if (!billedUser) {
		// The billed user doc is gone but the organization still points at it. Skip without
		// marking the day covered, so a repaired billed user meters normally again.
		console.error("Plugin storage metering found no billed user doc", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			billedUserId,
		});
		return 0;
	}

	const accrual = await ctx.db
		.query("billing_usage_accruals")
		.withIndex("by_billedUser_organization_workspace_kind", (q) =>
			q
				.eq("billedUserId", billedUserId)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("usageKind", "plugin_storage"),
		)
		.first();

	// The cron runs once daily, but a retried or manually replayed run must not
	// double-charge the same day.
	if (accrual && accrual.lastMeteredDay >= args.day) {
		return 0;
	}

	// Summing the accounting docs is exact because every write maintains them in its own
	// transaction. Reserved bytes promise capacity the store holds, so they count as stored.
	let storedBytes = 0;
	for await (const usage of ctx.db
		.query("plugins_data_usage")
		.withIndex("by_organization_workspace_installation", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)) {
		storedBytes += usage.usedBytes + usage.reservedBytes;
	}

	let fractionalCents = (accrual?.fractionalCents ?? 0) + storedBytes * PLUGIN_STORAGE_CENTS_PER_BYTE_DAY;
	const amountCents = Math.floor(fractionalCents);
	fractionalCents -= amountCents;

	if (accrual) {
		await ctx.db.patch("billing_usage_accruals", accrual._id, {
			fractionalCents,
			lastMeteredDay: args.day,
			updatedAt: args.now,
		});
	} else {
		await ctx.db.insert("billing_usage_accruals", {
			billedUserId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			usageKind: "plugin_storage",
			fractionalCents,
			lastMeteredDay: args.day,
			createdAt: args.now,
			updatedAt: args.now,
		});
	}

	// One event per covered day keeps the idempotency key unique without an emission
	// counter: the same-day guard means a given day can only ever flush once.
	if (amountCents > 0) {
		await billing_ingest_events(ctx, {
			billedUserEvents: [
				{
					billedUser,
					event: billing_event({
						name: "plugin_storage",
						externalCustomerId: billedUserId,
						externalId: composite_id(
							"billing",
							"plugin_storage",
							billedUserId,
							args.organizationId,
							args.workspaceId,
							args.day,
						),
						metadata: {
							amount: amountCents,
							billedUserId,
							organizationId: args.organizationId,
							workspaceId: args.workspaceId,
							storedBytes,
							day: args.day,
						},
					}),
				},
			],
		});
	}

	return amountCents > 0 ? 1 : 0;
}

// #endregion metered plugin storage
