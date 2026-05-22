import { Polar } from "@convex-dev/polar";
import { Workpool, vWorkId } from "@convex-dev/workpool";
import { customersCreate } from "@polar-sh/sdk/funcs/customersCreate.js";
import { customersDelete } from "@polar-sh/sdk/funcs/customersDelete.js";
import { customerSessionsCreate } from "@polar-sh/sdk/funcs/customerSessionsCreate.js";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { subscriptionsCreate } from "@polar-sh/sdk/funcs/subscriptionsCreate.js";
import { subscriptionsRevoke } from "@polar-sh/sdk/funcs/subscriptionsRevoke.js";
import { subscriptionsUpdate } from "@polar-sh/sdk/funcs/subscriptionsUpdate.js";
import type { CustomerState } from "@polar-sh/sdk/models/components/customerstate.js";
import { AlreadyCanceledSubscription } from "@polar-sh/sdk/models/errors/alreadycanceledsubscription.js";
import { PaymentFailed } from "@polar-sh/sdk/models/errors/paymentfailed.js";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound.js";
import { SubscriptionLocked } from "@polar-sh/sdk/models/errors/subscriptionlocked.js";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server.js";
import { Result, Result_try_async } from "../shared/errors-as-values-utils.ts";
import {
	billing_PRODUCTS,
	billing_get_plan_change_kind,
	billing_get_recurring_credits_cents,
} from "../shared/billing.ts";
import { date_get_day_start_timestamp, date_MS_DAYS_30 } from "../shared/date.ts";
import { composite_id } from "../shared/shared-utils.ts";
import {
	billing_POLAR_METER_EVENT,
	type billing_Event,
	billing_event,
	billing_polar_client,
} from "../server/billing.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import {
	allowed_origins,
	server_convex_get_user_fallback_to_anonymous,
	should_never_happen,
} from "../server/server-utils.ts";
import { convertToDatabaseSubscription } from "../vendor/polar/src/component/util.ts";
import app_convex_schema from "./schema.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";

if (!process.env.POLAR_SERVER) {
	throw new Error("POLAR_SERVER is not set");
}

const POLAR_SERVER = process.env.POLAR_SERVER as "sandbox" | "production";

/**
 * Single Polar client for this app: register webhook routes on this instance only, and use
 * {@link billing_polar.api} exports for Convex functions (see @convex-dev/polar README).
 */
export const billing_polar = new Polar<DataModel>(components.polar, {
	getUserInfo: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx as QueryCtx | ActionCtx);

		if (!userAuth || userAuth.kind !== "signed_in") {
			throw convex_error({ message: "Billing requires a signed-in account" });
		}

		return { userId: userAuth.id, email: userAuth.email, name: userAuth.name };
	},
	server: POLAR_SERVER,
});

const billing_workpool_usage_event = new Workpool(components.billing_workpool_usage_event, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 10 * 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

// #region check credits

export function billing_pick_billed_user_id(args: {
	userId: Id<"users">;
	workspace: Pick<Doc<"workspaces">, "default" | "billingMode" | "ownerUserId">;
}) {
	if (!args.workspace.default && args.workspace.billingMode === "workspace_owner") return args.workspace.ownerUserId;
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

			const product = await billing_polar.getProduct(ctx, { productId: usageSnapshot.subscription.productId });
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

export const check_credits = internalQuery({
	args: {
		userId: v.id("users"),
		workspaceId: v.optional(v.id("workspaces")),
		minimumRequiredCents: v.number(),
	},
	returns: v.object({
		hasCredits: v.boolean(),
		billedUser: v.optional(doc(app_convex_schema, "users")),
	}),
	handler: async (ctx, args) => {
		let billedUser: Doc<"users"> | null = null;
		if (args.workspaceId) {
			const workspace = await ctx.db.get("workspaces", args.workspaceId);
			if (!workspace) {
				throw should_never_happen("Workspace not found while checking credits", {
					userId: args.userId,
					workspaceId: args.workspaceId,
				});
			}

			// Use the current workspace owner as the payer only for owner-billed workspaces.
			// Ownership transfer changes future billing; in-flight operations keep their frozen billed user.
			const billedUserId = billing_pick_billed_user_id({
				userId: args.userId,
				workspace,
			});

			billedUser = await ctx.db.get("users", billedUserId);
			if (!billedUser) {
				throw should_never_happen("Billed user not found while checking credits", {
					userId: args.userId,
					workspaceId: args.workspaceId,
					billedUserId,
				});
			}
		}

		const creditCheck = await billing_db_check_credits(ctx, {
			userId: billedUser?._id ?? args.userId,
			minimumRequiredCents: args.minimumRequiredCents,
		});

		return {
			hasCredits: creditCheck.hasCredits,
			...(billedUser ? { billedUser } : {}),
		};
	},
});

// #endregion check credits

// #region anonymous credits

function create_anonymous_user_usage_snapshot_period(now: number) {
	const periodStartTs = date_get_day_start_timestamp(now);
	const currentPeriodStart = new Date(periodStartTs).toISOString();
	const currentPeriodEnd = new Date(periodStartTs + date_MS_DAYS_30).toISOString();
	return { currentPeriodStart, currentPeriodEnd };
}

/**
 * Ensure the user has a synthetic anonymous `billing_usage_snapshots` row.
 * Reuse the existing row when present; otherwise insert the current Free-plan snapshot.
 * Return `null` after the row is ensured.
 */
export async function billing_db_ensure_anonymous_user_usage_snapshot(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		now: number;
	},
) {
	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.first();
	if (usageSnapshot) {
		return null;
	}

	const freeProduct =
		(await billing_polar.listProducts(ctx)).find((product) => {
			return product.name === billing_PRODUCTS.Free.name && !product.isArchived;
		}) ?? null;
	if (!freeProduct) {
		throw should_never_happen("Free product not found among synced Polar products", {
			productName: billing_PRODUCTS.Free.name,
			userId: args.userId,
		});
	}

	const { currentPeriodStart, currentPeriodEnd } = create_anonymous_user_usage_snapshot_period(args.now);
	const recurringCreditsCents = billing_get_recurring_credits_cents(freeProduct.name);

	const snapshot = {
		userId: args.userId,
		polarCustomerId: null,
		subscription: {
			id: null,
			productId: freeProduct.id,
			currency: "eur",
			currentPeriodStart,
			currentPeriodEnd,
		},
		meter: {
			id: null,
			consumedUnits: 0,
			creditedUnits: recurringCreditsCents,
			balance: recurringCreditsCents,
			amountDueCents: 0,
		},
		lastSyncedAt: args.now,
	} satisfies BillingUsageSnapshotRow;

	await ctx.db.insert("billing_usage_snapshots", snapshot);
	return null;
}

export const reset_due_anonymous_credits = internalMutation({
	args: {
		/**
		 * Internal simulated wall time (ms) used by tests to target one due UTC day.
		 *
		 * Omit in normal production and cron flows (`Date.now()` is used).
		 */
		_test_now: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const todayPeriodEnd = new Date(date_get_day_start_timestamp(now)).toISOString();
		const recurringCreditsCents = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);
		const { currentPeriodStart, currentPeriodEnd } = create_anonymous_user_usage_snapshot_period(now);

		const dueUsageSnapshots = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_polarCustomer_currentPeriodEnd", (q) =>
				q.eq("polarCustomerId", null).eq("subscription.currentPeriodEnd", todayPeriodEnd),
			)
			.collect();

		await Promise.all(
			dueUsageSnapshots.map(async (usageSnapshot) => {
				if (!usageSnapshot.subscription || !usageSnapshot.meter) {
					console.error("Anonymous billing usage snapshot is missing subscription or meter", { usageSnapshot });
					return;
				}

				await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
					subscription: {
						...usageSnapshot.subscription,
						currentPeriodStart,
						currentPeriodEnd,
					},
					meter: {
						...usageSnapshot.meter,
						consumedUnits: 0,
						creditedUnits: recurringCreditsCents,
						balance: recurringCreditsCents,
					},
					lastSyncedAt: now,
				});
			}),
		);

		return null;
	},
});

// #endregion anonymous credits

export async function billing_action_delete_polar_customer_by_user_id(
	ctx: ActionCtx | MutationCtx,
	args: {
		userId: Id<"users">;
	},
) {
	const customer = await billing_polar.getCustomerByUserId(ctx, args.userId);
	if (!customer) {
		return Result({ _yay: null });
	}

	// Keep using Polar's hard-delete path here; anonymization emits `deleted_at`
	// updates instead of `customer.deleted`.
	const deleteResult = await customersDelete(billing_polar_client(), {
		id: customer.id,
		anonymize: false,
	});
	if (!deleteResult.ok && !(deleteResult.error instanceof ResourceNotFound)) {
		return Result({
			_nay: {
				message: "Failed to delete Polar customer",
				cause: deleteResult.error,
			},
		});
	}

	return Result({ _yay: null });
}

export async function billing_action_revoke_polar_subscription(args: { subscriptionId: string }) {
	const revokeResult = await subscriptionsRevoke(billing_polar_client(), {
		id: args.subscriptionId,
	});
	if (
		!revokeResult.ok &&
		!(revokeResult.error instanceof AlreadyCanceledSubscription) &&
		!(revokeResult.error instanceof ResourceNotFound)
	) {
		return Result({
			_nay: {
				message: "Failed to revoke Polar subscription",
				cause: revokeResult.error,
			},
		});
	}

	return Result({ _yay: null });
}

async function action_cancel_polar_subscription_at_period_end(args: { subscriptionId: string }) {
	const cancelResult = await subscriptionsUpdate(billing_polar_client(), {
		id: args.subscriptionId,
		subscriptionUpdate: {
			cancelAtPeriodEnd: true,
		},
	});
	if (
		!cancelResult.ok &&
		!(cancelResult.error instanceof AlreadyCanceledSubscription) &&
		!(cancelResult.error instanceof ResourceNotFound)
	) {
		return Result({
			_nay: {
				message: "Failed to cancel Polar subscription at period end",
				cause: cancelResult.error,
			},
		});
	}

	return Result({ _yay: null });
}

async function action_uncancel_polar_subscription(args: { subscriptionId: string }) {
	const uncancelResult = await subscriptionsUpdate(billing_polar_client(), {
		id: args.subscriptionId,
		subscriptionUpdate: {
			cancelAtPeriodEnd: false,
		},
	});
	if (!uncancelResult.ok) {
		return Result({
			_nay: {
				message: "Failed to restore Polar subscription",
				cause: uncancelResult.error,
			},
		});
	}

	return Result({ _yay: uncancelResult.value });
}

export const get_usage_snapshot = query({
	args: {},
	returns: v.union(v.null(), doc(app_convex_schema, "billing_usage_snapshots")),
	handler: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return null;
		}

		const usageSnapshot = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_user", (q) => q.eq("userId", userAuth.id))
			.first();

		return usageSnapshot;
	},
});

export const list_products = query({
	args: {},
	handler: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return [];
		}

		return await billing_polar.listProducts(ctx);
	},
});

export const get_current_user_subscription = query({
	args: {},
	handler: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return null;
		}

		const currentSubscription = await billing_polar.getCurrentSubscription(ctx, { userId: userAuth.id });
		if (!currentSubscription) {
			return null;
		}

		const { product, productKey, ...subscription } = currentSubscription;
		return subscription;
	},
});

/**
 * Canonical customer-state shape for snapshot refreshes.
 * Keep dates as ISO strings so webhook and SDK inputs share one mutation-safe type.
 */
/** Local shape of the `customer.state_changed` webhook payload. */
type BillingPolarCustomerStateWebhookData = {
	id: string;
	external_id: string | null;
	deleted_at?: string | null;
	active_subscriptions: Array<{
		id: string;
		product_id: string;
		currency: string;
		current_period_start: string;
		current_period_end: string;
		meters: Array<{
			meter_id: string;
			consumed_units: number;
			credited_units: number;
			amount: number;
		}>;
	}>;
	active_meters: Array<{
		meter_id: string;
		consumed_units: number;
		credited_units: number;
		balance: number;
	}>;
};

// Convert the webhook payload to the canonical shape.
function billing_polar_webhook_to_customer_state(data: BillingPolarCustomerStateWebhookData) {
	return {
		id: data.id,
		externalId: data.external_id,
		deletedAt: data.deleted_at ?? null,
		activeSubscriptions: data.active_subscriptions.map((sub) => ({
			id: sub.id,
			productId: sub.product_id,
			currency: sub.currency,
			currentPeriodStart: sub.current_period_start,
			currentPeriodEnd: sub.current_period_end,
			meters: sub.meters.map((meter) => ({
				meterId: meter.meter_id,
				consumedUnits: meter.consumed_units,
				creditedUnits: meter.credited_units,
				amount: meter.amount,
			})),
		})),
		activeMeters: data.active_meters.map((meter) => ({
			meterId: meter.meter_id,
			consumedUnits: meter.consumed_units,
			creditedUnits: meter.credited_units,
			balance: meter.balance,
		})),
	};
}

// Convert the SDK `CustomerState` to the canonical shape with ISO string dates.
function billing_polar_sdk_to_db_data(state: CustomerState) {
	return {
		id: state.id,
		externalId: state.externalId ?? null,
		deletedAt: state.deletedAt ? state.deletedAt.toISOString() : null,
		activeSubscriptions: state.activeSubscriptions.map((sub) => ({
			id: sub.id,
			productId: sub.productId,
			currency: sub.currency,
			currentPeriodStart: sub.currentPeriodStart.toISOString(),
			currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
			meters: sub.meters.map((meter) => ({
				meterId: meter.meterId,
				consumedUnits: meter.consumedUnits,
				creditedUnits: meter.creditedUnits,
				amount: meter.amount,
			})),
		})),
		activeMeters: state.activeMeters.map((meter) => ({
			meterId: meter.meterId,
			consumedUnits: meter.consumedUnits,
			creditedUnits: meter.creditedUnits,
			balance: meter.balance,
		})),
	};
}

type BillingProductLike = {
	name: string;
	prices?: Array<{
		isArchived: boolean;
		amountType?: string;
		meterId?: string;
	}>;
	benefits?: Array<{
		type: string;
		properties?: unknown;
	}>;
};

/**
 * Resolve the app's customer-meter id.
 *
 * Prefer subscription meter, then synced metered price, then legacy
 * `meter_credit`. Return `null` before the first monthly credit creates one.
 */
function billing_resolve_customer_meter_id(args: {
	subscriptionMeterId: string | null;
	syncedProducts: Array<BillingProductLike>;
	product: BillingProductLike | null;
}): string | null {
	if (args.subscriptionMeterId) {
		return args.subscriptionMeterId;
	}

	for (const syncedProduct of args.syncedProducts) {
		const meteredPrice = syncedProduct.prices?.find((price) => {
			return !price.isArchived && price.amountType === "metered_unit" && typeof price.meterId === "string";
		});
		if (meteredPrice?.meterId) {
			return meteredPrice.meterId;
		}
	}

	const creditBenefit = args.product?.benefits?.find((benefit) => benefit.type === "meter_credit");
	if (
		typeof creditBenefit?.properties === "object" &&
		creditBenefit.properties !== null &&
		"meterId" in creditBenefit.properties &&
		typeof creditBenefit.properties.meterId === "string"
	) {
		return creditBenefit.properties.meterId;
	}

	return null;
}

type BillingUsageSnapshotRow = Omit<Doc<"billing_usage_snapshots">, "_id" | "_creationTime">;

/**
 * Build `billing_usage_snapshots` from canonical customer state.
 * Keep balance from the customer meter and amount due from the subscription meter.
 */
function build_usage_snapshot(args: {
	state: ReturnType<typeof billing_polar_webhook_to_customer_state>;
	product: BillingProductLike | null;
	syncedProducts: Array<BillingProductLike>;
	syncedAt: number;
}): BillingUsageSnapshotRow {
	const { state, product, syncedProducts, syncedAt } = args;
	const userId = state.externalId as Id<"users">;
	const subscription = state.activeSubscriptions[0] ?? null;
	const subscriptionMeter = subscription?.meters[0] ?? null;
	const isFreeSubscription = product?.name === billing_PRODUCTS.Free.name;
	const hasMeteredPrice =
		product?.prices?.some((price) => !price.isArchived && price.amountType === "metered_unit") ?? false;

	// Paid metered plans must include a subscription meter.
	if (subscription && !isFreeSubscription && hasMeteredPrice && !subscriptionMeter) {
		throw should_never_happen("Failed to resolve subscription meter for paid plan", {
			customerId: state.id,
			product,
			subscription,
			userId,
		});
	}

	const customerMeterId = billing_resolve_customer_meter_id({
		subscriptionMeterId: subscriptionMeter?.meterId ?? null,
		syncedProducts,
		product,
	});
	const customerMeter = customerMeterId
		? (state.activeMeters.find((meter) => meter.meterId === customerMeterId) ?? null)
		: null;

	const usageMeter: BillingUsageSnapshotRow["meter"] = customerMeter
		? {
				id: customerMeter.meterId,
				consumedUnits: customerMeter.consumedUnits,
				creditedUnits: customerMeter.creditedUnits,
				balance: customerMeter.balance,
				amountDueCents: subscriptionMeter?.amount ?? 0,
			}
		: subscriptionMeter
			? {
					id: subscriptionMeter.meterId,
					consumedUnits: subscriptionMeter.consumedUnits,
					creditedUnits: subscriptionMeter.creditedUnits,
					balance: subscriptionMeter.creditedUnits - subscriptionMeter.consumedUnits,
					amountDueCents: subscriptionMeter.amount,
				}
			: null;

	return {
		userId,
		polarCustomerId: state.id,
		subscription: subscription
			? {
					id: subscription.id,
					productId: subscription.productId,
					currency: subscription.currency,
					currentPeriodStart: subscription.currentPeriodStart,
					currentPeriodEnd: subscription.currentPeriodEnd,
				}
			: null,
		meter: usageMeter,
		lastSyncedAt: syncedAt,
	};
}

async function db_upsert_usage_snapshot(ctx: MutationCtx, usageSnapshot: BillingUsageSnapshotRow) {
	const existingUsageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", usageSnapshot.userId))
		.unique();
	// Keep an existing meter when Polar still reports `activeMeters: []`.
	// This avoids wiping an optimistic meter before Polar catches up.
	const next =
		existingUsageSnapshot &&
		existingUsageSnapshot.meter &&
		!usageSnapshot.meter &&
		usageSnapshot.subscription?.id != null
			? { ...usageSnapshot, meter: existingUsageSnapshot.meter }
			: usageSnapshot;
	console.info("upsert billing_usage_snapshots", {
		userId: next.userId,
		action: existingUsageSnapshot ? "patch" : "insert",
		existingId: existingUsageSnapshot?._id ?? null,
		meter: next.meter,
		subscription: next.subscription,
		polarCustomerId: next.polarCustomerId,
		lastSyncedAt: new Date(next.lastSyncedAt).toISOString(),
		preservedExistingMeter:
			existingUsageSnapshot?.meter != null && usageSnapshot.meter == null && usageSnapshot.subscription?.id != null,
	});
	if (existingUsageSnapshot) {
		await ctx.db.patch("billing_usage_snapshots", existingUsageSnapshot._id, next);
	} else {
		await ctx.db.insert("billing_usage_snapshots", next);
	}
}

async function db_delete_customer_state(
	ctx: MutationCtx,
	state: ReturnType<typeof billing_polar_webhook_to_customer_state>,
) {
	// Treat `deletedAt` as the delete signal for anonymized customers.
	await ctx.runMutation(components.polar.lib.deleteCustomerByPolarCustomerId, {
		polarCustomerId: state.id,
	});

	const userId = state.externalId ? ctx.db.normalizeId("users", state.externalId) : null;
	// Fall back to `polarCustomerId` because anonymization can clear `externalId`.
	const usageSnapshots = userId
		? await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.collect()
		: await ctx.db
				.query("billing_usage_snapshots")
				.filter((q) => q.eq(q.field("polarCustomerId"), state.id))
				.collect();
	for (const usageSnapshot of usageSnapshots) {
		await ctx.db.delete("billing_usage_snapshots", usageSnapshot._id);
	}
}

/**
 * Reconcile canonical Polar customer state into `billing_usage_snapshots`.
 * Used by both the webhook path and the admin replay action.
 */
async function db_apply_polar_customer_state_refresh(
	ctx: MutationCtx,
	args: {
		state: ReturnType<typeof billing_polar_webhook_to_customer_state>;
		syncedAt: number;
	},
) {
	const { state, syncedAt } = args;

	if (state.deletedAt) {
		// Polar anonymization can arrive as a state change with `deletedAt`.
		await db_delete_customer_state(ctx, state);
		return;
	}

	if (state.activeSubscriptions.length > 1) {
		throw should_never_happen("Multiple active subscriptions are not supported", {
			activeSubscriptions: state.activeSubscriptions,
			customerId: state.id,
			userId: state.externalId,
		});
	}

	// Read the current subscription before the upsert so the period gate can compare it.
	const user = await ctx.db.get("users", state.externalId as Id<"users">);
	if (!user) {
		throw should_never_happen("Missing user while applying monthly billing credit", {
			activeSubscriptions: state.activeSubscriptions,
			customerId: state.id,
			userId: state.externalId,
		});
	}

	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", user._id))
		.unique();
	const previousSubscription = usageSnapshot?.subscription ?? null;

	const subscription = state.activeSubscriptions[0] ?? null;
	const product = subscription ? await billing_polar.getProduct(ctx, { productId: subscription.productId }) : null;
	const syncedProducts = await billing_polar.listProducts(ctx);

	const snapshot = build_usage_snapshot({
		state,
		product,
		syncedProducts,
		syncedAt,
	});
	await db_upsert_usage_snapshot(ctx, snapshot);

	// Grant only on a new subscription period or plan change.
	// Same-period webhook repeats must not re-credit the optimistic meter.
	if (subscription?.id != null && product) {
		const recurringAmountCents = billing_get_recurring_credits_cents(product.name);
		const periodChanged =
			previousSubscription?.id == null ||
			previousSubscription.id !== subscription.id ||
			previousSubscription.currentPeriodStart !== subscription.currentPeriodStart;
		if (recurringAmountCents > 0 && periodChanged) {
			await db_apply_optimistic_credit_to_snapshot(ctx, {
				userId: user._id,
				syncedProducts,
				product,
				amountCents: recurringAmountCents,
				syncedAt,
			});
			await billing_ingest_events(ctx, {
				billedUserEvents: [
					{
						billedUser: user,
						event: billing_event({
							name: "monthly_credit",
							externalCustomerId: user._id,
							externalId: composite_id(
								"billing",
								"monthly_credit",
								user._id,
								subscription.id,
								subscription.currentPeriodStart,
							),
							metadata: {
								amount: -recurringAmountCents,
								subscriptionId: subscription.id,
								productId: subscription.productId,
								productName: product.name,
								periodStart: subscription.currentPeriodStart,
							},
						}),
					},
				],
			});
		}
	}
}

/**
 * Apply the recurring credit to the local snapshot before Polar updates `activeMeters`.
 * Mirror Polar's meter math locally; the caller owns the period gate.
 */
async function db_apply_optimistic_credit_to_snapshot(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		syncedProducts: Array<BillingProductLike>;
		product: BillingProductLike;
		amountCents: number;
		syncedAt: number;
	},
) {
	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.unique();
	// The snapshot was upserted earlier in this transaction, so the row must exist.
	if (!usageSnapshot) {
		throw should_never_happen("Snapshot row missing for optimistic credit", {
			userId: args.userId,
		});
	}

	const meterId =
		billing_resolve_customer_meter_id({
			subscriptionMeterId: null,
			syncedProducts: args.syncedProducts,
			product: args.product,
		}) ??
		usageSnapshot.meter?.id ??
		null;

	const previous = usageSnapshot.meter;
	const nextMeter: NonNullable<typeof usageSnapshot.meter> | null = previous
		? {
				...previous,
				consumedUnits: previous.consumedUnits - args.amountCents,
				balance: previous.balance + args.amountCents,
			}
		: meterId
			? {
					id: meterId,
					consumedUnits: -args.amountCents,
					creditedUnits: 0,
					balance: args.amountCents,
					amountDueCents: 0,
				}
			: null;

	if (!nextMeter) return;

	await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
		meter: nextMeter,
		lastSyncedAt: args.syncedAt,
	});
}

/**
 * @see https://polar.sh/docs/api-reference/webhooks/customer.state_changed
 */
export const handle_polar_customer_state_update = internalMutation({
	args: {
		payload: v.any(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const payload = args.payload as {
			type: "customer.state_changed";
			timestamp: string;
			data: BillingPolarCustomerStateWebhookData;
		};
		const state = billing_polar_webhook_to_customer_state(payload.data);
		const syncedAt = Date.parse(payload.timestamp);
		console.info("handle_polar_customer_state_update start", {
			externalId: state.externalId,
			polarCustomerId: state.id,
			payloadTimestamp: payload.timestamp,
			activeSubscriptionsCount: state.activeSubscriptions.length,
			activeMeters: state.activeMeters.map((m) => ({
				meterId: m.meterId,
				balance: m.balance,
				consumedUnits: m.consumedUnits,
				creditedUnits: m.creditedUnits,
			})),
		});

		await db_apply_polar_customer_state_refresh(ctx, { state, syncedAt });

		return null;
	},
});

/**
 * Checkout for a single Polar product id synced into this deployment. The product must exist in {@link billing_polar.listProducts} and
 * must not be archived. {@link origin} and {@link successUrl} are checked against {@link allowed_origins}.
 */
export const generate_checkout_link = action({
	args: {
		productId: v.string(),
		origin: v.string(),
		successUrl: v.string(),
		subscriptionId: v.optional(v.string()),
		metadata: v.optional(v.record(v.string(), v.string())),
		trialInterval: v.optional(v.union(v.string(), v.null())),
		trialIntervalCount: v.optional(v.union(v.number(), v.null())),
		locale: v.optional(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			url: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		let originParsed: URL;
		let successParsed: URL;
		try {
			originParsed = new URL(args.origin);
			successParsed = new URL(args.successUrl);
		} catch {
			return Result({ _nay: { message: "Invalid checkout URL" } });
		}

		const allowedOrigins = allowed_origins();

		if (!allowedOrigins.includes(originParsed.origin)) {
			return Result({ _nay: { message: "Origin is not allowed for checkout" } });
		}

		const successOk = allowedOrigins.some(
			(allowedOrigin) => successParsed.origin === allowedOrigin || successParsed.href.startsWith(`${allowedOrigin}/`),
		);
		if (!successOk) {
			return Result({ _nay: { message: "Success URL is not allowed for checkout" } });
		}

		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "A signed-in account is required for checkout" } });
		}

		const product =
			(await billing_polar.listProducts(ctx)).find((product) => {
				return product.id === args.productId && !product.isArchived;
			}) ?? null;
		if (!product) {
			return Result({ _nay: { message: "Invalid checkout product" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "billing_action", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const checkoutSessionResult = await Result_try_async(() =>
			billing_polar.createCheckoutSession(ctx, {
				productIds: [product.id],
				userId: userAuth.id,
				email: userAuth.email,
				name: userAuth.name,
				subscriptionId: args.subscriptionId,
				origin: args.origin,
				successUrl: args.successUrl,
				metadata: args.metadata,
				trialInterval: args.trialInterval as "day" | "week" | "month" | "year" | null | undefined,
				trialIntervalCount: args.trialIntervalCount,
			}),
		);
		if (checkoutSessionResult._nay) {
			return Result({ _nay: { message: "Failed to create a checkout link", cause: checkoutSessionResult._nay } });
		}
		if (!checkoutSessionResult._yay) {
			return Result({ _nay: { message: "Failed to create a checkout link" } });
		}
		const checkoutSession = checkoutSessionResult._yay;

		let url = checkoutSession.url;
		if (args.locale) {
			const localeUrl = new URL(url);
			localeUrl.searchParams.set("locale", args.locale);
			url = localeUrl.toString();
		}

		return Result({ _yay: { url } });
	},
});

export const generate_customer_portal_url = action({
	args: {},
	returns: v_result({
		_yay: v.object({
			url: v.string(),
		}),
	}),
	handler: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "A signed-in account is required for billing" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "billing_action", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const customer = await billing_polar.getCustomerByUserId(ctx, userAuth.id);
		if (!customer) {
			return Result({ _nay: { message: "Customer not found" } });
		}

		const session = await customerSessionsCreate(billing_polar.polar, {
			customerId: customer.id,
		});
		if (!session.ok) {
			return Result({ _nay: { message: "Failed to create customer portal session" } });
		}

		return Result({ _yay: { url: session.value.customerPortalUrl } });
	},
});

// #region cancellation
const billing_workpool_cancellation = new Workpool(components.billing_workpool_cancellation, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 10 * 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

export const get_cancel_polar_subscription_job_by_user_id = internalQuery({
	args: {
		userId: v.id("users"),
	},
	returns: v.union(v.null(), doc(app_convex_schema, "billing_cancel_polar_subscription_jobs")),
	handler: async (ctx, args) => {
		return (
			(await ctx.db
				.query("billing_cancel_polar_subscription_jobs")
				.withIndex("by_user", (q) => q.eq("userId", args.userId))
				.first()) ?? null
		);
	},
});

export const upsert_cancel_polar_subscription_job = internalMutation({
	args: {
		userId: v.id("users"),
		jobId: vWorkId,
		updatedAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existingRows = await ctx.db
			.query("billing_cancel_polar_subscription_jobs")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect();
		const [currentRow, ...staleDocs] = existingRows;

		await Promise.all(staleDocs.map((doc) => ctx.db.delete("billing_cancel_polar_subscription_jobs", doc._id)));

		if (currentRow) {
			await ctx.db.patch("billing_cancel_polar_subscription_jobs", currentRow._id, {
				jobId: args.jobId,
				updatedAt: args.updatedAt,
			});

			return null;
		}

		await ctx.db.insert("billing_cancel_polar_subscription_jobs", args);

		return null;
	},
});

export const delete_cancel_polar_subscription_job = internalMutation({
	args: {
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const docs = await ctx.db
			.query("billing_cancel_polar_subscription_jobs")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect();

		await Promise.all(docs.map((doc) => ctx.db.delete("billing_cancel_polar_subscription_jobs", doc._id)));

		return null;
	},
});

export const complete_polar_subscription_period_end_cancellation = billing_workpool_cancellation.defineOnComplete({
	context: v.object({
		userId: v.id("users"),
	}),
	handler: async (ctx, args) => {
		const userId = args.context.userId as Id<"users">;
		const doc = await ctx.db
			.query("billing_cancel_polar_subscription_jobs")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first();
		if (!doc || doc.jobId !== args.workId) {
			return;
		}

		if (args.result.kind === "success") {
			await ctx.db.delete(
				"billing_cancel_polar_subscription_jobs",
				doc._id as Id<"billing_cancel_polar_subscription_jobs">,
			);
		}

		return;
	},
});

export async function billing_action_schedule_polar_subscription_period_end_cancellation(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		subscriptionId: string;
	},
) {
	const existingRow = await ctx.runQuery(internal.billing.get_cancel_polar_subscription_job_by_user_id, {
		userId: args.userId,
	});
	if (existingRow) {
		await billing_workpool_cancellation.cancel(ctx, existingRow.jobId);
	}

	const jobId = await billing_workpool_cancellation.enqueueAction(
		ctx,
		internal.billing.cancel_polar_subscription_at_period_end,
		args,
		{
			context: {
				userId: args.userId,
			},
			onComplete: internal.billing.complete_polar_subscription_period_end_cancellation,
		},
	);

	await ctx.runMutation(internal.billing.upsert_cancel_polar_subscription_job, {
		userId: args.userId,
		jobId,
		updatedAt: Date.now(),
	});

	return jobId;
}

export async function billing_action_cancel_scheduled_polar_subscription_period_end_cancellation(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
	},
) {
	const existingRow = await ctx.runQuery(internal.billing.get_cancel_polar_subscription_job_by_user_id, {
		userId: args.userId,
	});
	if (!existingRow) {
		return null;
	}

	await billing_workpool_cancellation.cancel(ctx, existingRow.jobId);
	await ctx.runMutation(internal.billing.delete_cancel_polar_subscription_job, {
		userId: args.userId,
	});

	return null;
}

export const schedule_polar_subscription_period_end_cancellation = internalAction({
	args: {
		userId: v.id("users"),
		subscriptionId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await billing_action_schedule_polar_subscription_period_end_cancellation(ctx, args);

		return null;
	},
});

export const cancel_scheduled_polar_subscription_period_end_cancellation = internalAction({
	args: {
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		return await billing_action_cancel_scheduled_polar_subscription_period_end_cancellation(ctx, args);
	},
});

export const cancel_polar_subscription_at_period_end = internalAction({
	args: {
		userId: v.id("users"),
		subscriptionId: v.string(),
	},
	returns: v.null(),
	handler: async (_ctx, args) => {
		const cancelSubscriptionResult = await action_cancel_polar_subscription_at_period_end({
			subscriptionId: args.subscriptionId,
		});
		if (cancelSubscriptionResult._nay) {
			console.error("Failed to cancel Polar subscription at period end", {
				cancelSubscriptionResult,
				subscriptionId: args.subscriptionId,
				userId: args.userId,
			});
			throw convex_error({
				message: "Failed to cancel Polar subscription at period end",
				cause: cancelSubscriptionResult._nay,
				data: {
					subscriptionId: args.subscriptionId,
					userId: args.userId,
				},
			});
		}

		return null;
	},
});
// #endregion cancellation

// #region bootstrap
const billing_workpool_bootstrap = new Workpool(components.billing_workpool_bootstrap, {
	maxParallelism: 1,
	retryActionsByDefault: true,
});

export async function billing_action_enqueue_free_subscription_bootstrap(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		email: string;
		name: string;
		restoreCanceledSubscription?: boolean;
	},
) {
	return await billing_workpool_bootstrap.enqueueAction(ctx, internal.billing.bootstrap_free_subscription, args);
}

export const bootstrap_free_subscription = internalAction({
	args: {
		userId: v.id("users"),
		email: v.string(),
		name: v.string(),
		restoreCanceledSubscription: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const bootstrapResult = await Result_try_async(async () => {
			let customer = await billing_polar.getCustomerByUserId(ctx, args.userId);

			if (!customer) {
				const createCustomerResult = await customersCreate(billing_polar.polar, {
					externalId: args.userId,
					email: args.email,
					name: args.name,
				});
				if (!createCustomerResult.ok) {
					throw convex_error({
						message: "Failed to create Polar customer",
						cause: createCustomerResult.error,
						data: {
							email: args.email,
							name: args.name,
							userId: args.userId,
						},
					});
				}

				await ctx.runMutation(components.polar.lib.insertCustomer, {
					id: createCustomerResult.value.id,
					userId: args.userId,
				});

				customer = await billing_polar.getCustomerByUserId(ctx, args.userId);
			}

			if (!customer) {
				throw should_never_happen("Failed to persist Polar customer", {
					userId: args.userId,
				});
			}

			const currentSubscription = await billing_polar.getCurrentSubscription(ctx, { userId: args.userId });
			if (currentSubscription) {
				if (
					args.restoreCanceledSubscription &&
					currentSubscription.cancelAtPeriodEnd &&
					currentSubscription.endedAt == null &&
					(currentSubscription.status === "active" || currentSubscription.status === "trialing")
				) {
					// Account recovery reverses the deletion-triggered period-end
					// cancellation while Polar still considers the subscription billable.
					await billing_action_cancel_scheduled_polar_subscription_period_end_cancellation(ctx, {
						userId: args.userId,
					});

					const uncancelSubscriptionResult = await action_uncancel_polar_subscription({
						subscriptionId: currentSubscription.id,
					});
					if (uncancelSubscriptionResult._nay) {
						throw convex_error({
							message: "Failed to restore Polar subscription",
							cause: uncancelSubscriptionResult._nay,
							data: {
								subscriptionId: currentSubscription.id,
								userId: args.userId,
							},
						});
					}

					await ctx.runMutation(components.polar.lib.updateSubscription, {
						subscription: convertToDatabaseSubscription(uncancelSubscriptionResult._yay),
					});
				}

				return;
			}

			const freeProduct =
				(await billing_polar.listProducts(ctx)).find((product) => {
					return product.name === billing_PRODUCTS.Free.name && !product.isArchived;
				}) ?? null;
			if (!freeProduct) {
				throw should_never_happen("Free product not found among synced Polar products", {
					productName: billing_PRODUCTS.Free.name,
					userId: args.userId,
				});
			}

			console.info("bootstrap subscriptionsCreate start", {
				userId: args.userId,
				customerId: customer.id,
				productId: freeProduct.id,
				startedAt: new Date().toISOString(),
			});
			const createSubscriptionResult = await subscriptionsCreate(billing_polar.polar, {
				customerId: customer.id,
				productId: freeProduct.id,
			});
			if (!createSubscriptionResult.ok) {
				throw convex_error({
					message: "Failed to create Free subscription",
					cause: createSubscriptionResult.error,
					data: {
						customerId: customer.id,
						productId: freeProduct.id,
						userId: args.userId,
					},
				});
			}
			console.info("bootstrap subscriptionsCreate ok", {
				userId: args.userId,
				customerId: customer.id,
				subscriptionId: createSubscriptionResult.value.id,
				status: createSubscriptionResult.value.status,
				respondedAt: new Date().toISOString(),
			});

			await ctx.runMutation(components.polar.lib.createSubscription, {
				subscription: convertToDatabaseSubscription(createSubscriptionResult.value),
			});
		});
		if (bootstrapResult._nay) {
			console.error("Failed to bootstrap Free subscription", {
				error: bootstrapResult._nay,
				userId: args.userId,
			});
			throw convex_error({
				message: "Failed to bootstrap Free subscription",
				cause: bootstrapResult._nay,
				data: {
					email: args.email,
					userId: args.userId,
				},
			});
		}

		return null;
	},
});
// #endregion bootstrap

export const change_current_subscription = action({
	args: {
		productId: v.string(),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "A signed-in account is required for billing" } });
		}

		const currentSubscription = await billing_polar.getCurrentSubscription(ctx, { userId: userAuth.id });
		if (
			!currentSubscription ||
			(currentSubscription.status !== "active" && currentSubscription.status !== "trialing")
		) {
			return Result({ _nay: { message: "No active subscription found" } });
		}

		const targetProduct =
			(await billing_polar.listProducts(ctx)).find((product) => {
				return product.id === args.productId && !product.isArchived;
			}) ?? null;
		if (!targetProduct) {
			return Result({ _nay: { message: "Invalid target plan" } });
		}
		if (currentSubscription.productId === targetProduct.id) {
			return Result({ _nay: { message: "You're already on this plan" } });
		}

		const currentBillingProduct =
			billing_PRODUCTS[currentSubscription.product.name as keyof typeof billing_PRODUCTS] ?? null;
		const targetBillingProduct = billing_PRODUCTS[targetProduct.name as keyof typeof billing_PRODUCTS] ?? null;
		if (!currentBillingProduct || !targetBillingProduct) {
			return Result({ _nay: { message: "Unsupported plan change" } });
		}
		if (currentBillingProduct.name === billing_PRODUCTS.Free.name) {
			return Result({ _nay: { message: "Use checkout to upgrade from Free" } });
		}

		const changeKind = billing_get_plan_change_kind(currentBillingProduct.name, targetBillingProduct.name);
		if (!changeKind) {
			return Result({ _nay: { message: "Plan changes between equivalent tiers are not supported" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "billing_action", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const prorationBehavior = changeKind === "upgrade" ? "invoice" : "next_period";
		const updateResult = await subscriptionsUpdate(billing_polar.polar, {
			id: currentSubscription.id,
			subscriptionUpdate: {
				productId: targetProduct.id,
				prorationBehavior,
			},
		});
		if (!updateResult.ok) {
			if (updateResult.error instanceof PaymentFailed) {
				return Result({ _nay: { message: "Payment failed while updating the subscription" } });
			}
			if (updateResult.error instanceof SubscriptionLocked) {
				return Result({ _nay: { message: "Subscription is locked and cannot be changed right now" } });
			}
			if (updateResult.error instanceof ResourceNotFound) {
				return Result({ _nay: { message: "Subscription not found" } });
			}

			console.error("Failed to change the subscription", {
				error: updateResult.error,
				subscriptionId: currentSubscription.id,
				targetProductId: targetProduct.id,
			});
			return Result({
				_nay: {
					message: "Failed to change the subscription",
				},
			});
		}

		return Result({ _yay: null });
	},
});

export const cancel_current_subscription = action({
	args: {
		revokeImmediately: v.optional(v.boolean()),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "A signed-in account is required for billing" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "billing_action", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const cancelResult = await Result_try_async(() =>
			billing_polar.cancelSubscription(ctx, { revokeImmediately: args.revokeImmediately }),
		);
		if (cancelResult._nay) {
			const message = cancelResult._nay.message;
			if (message === "Subscription not found") {
				return Result({ _nay: { message: "Subscription not found" } });
			}
			if (message === "Subscription is not active") {
				return Result({ _nay: { message: "Subscription is not active" } });
			}

			return Result({
				_nay: {
					message: "Failed to cancel current subscription",
					cause: cancelResult._nay,
				},
			});
		}

		return Result({ _yay: null });
	},
});

// #region event ingestion
const billing_event_validator = v.union(
	v.object({
		name: v.literal("manual_credit"),
		externalCustomerId: v.id("users"),
		externalId: v.string(),
		metadata: v.object({
			amount: v.number(),
		}),
	}),
	v.object({
		name: v.literal("file_save"),
		externalCustomerId: v.id("users"),
		externalMemberId: v.optional(v.id("users")),
		externalId: v.string(),
		metadata: v.object({
			amount: v.number(),
			actorUserId: v.id("users"),
			billedUserId: v.id("users"),
			workspaceId: v.string(),
			projectId: v.string(),
			nodeId: v.string(),
			yjsSequence: v.string(),
		}),
	}),
	v.object({
		name: v.literal("monthly_credit"),
		externalCustomerId: v.id("users"),
		externalId: v.string(),
		metadata: v.object({
			amount: v.number(),
			subscriptionId: v.string(),
			productId: v.string(),
			productName: v.string(),
			periodStart: v.string(),
		}),
	}),
	v.object({
		name: v.literal("ai_usage"),
		externalCustomerId: v.id("users"),
		externalMemberId: v.optional(v.id("users")),
		externalId: v.string(),
		metadata: v.object({
			amount: v.number(),
			actorUserId: v.id("users"),
			billedUserId: v.id("users"),
			workspaceId: v.string(),
			projectId: v.string(),
			modelId: v.string(),
			inputTokens: v.number(),
			outputTokens: v.number(),
			threadId: v.string(),
			messageId: v.string(),
		}),
	}),
);

export const ingest_events = internalAction({
	args: {
		events: v.array(billing_event_validator),
	},
	handler: async (_ctx, args) => {
		// Skip direct Polar calls in tests; tests usually assert the queued payload.
		if (process.env.NODE_ENV === "test") {
			return;
		}

		// Polar uses one meter event; keep the app event name in metadata.
		const ingestResult = await eventsIngest(billing_polar_client(), {
			events: args.events.map((event) => {
				const { name, metadata, ...polarEvent } = event;

				return {
					...polarEvent,
					name: billing_POLAR_METER_EVENT,
					metadata: {
						...metadata,
						name,
					},
				};
			}),
		});
		if (!ingestResult.ok) {
			throw new Error(JSON.stringify(ingestResult.error));
		}
	},
});

export const ingest_anonymous_user_events = internalMutation({
	args: {
		billedUserEvents: v.array(
			v.object({
				event: billing_event_validator,
				billedUser: doc(app_convex_schema, "users"),
			}),
		),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();

		await Promise.all(
			args.billedUserEvents.map(async ({ event, billedUser }) => {
				if (billedUser.clerkUserId != null) {
					console.error("Anonymous billing ingest received a signed-in user row", {
						billedUserId: billedUser._id,
						event,
					});
					return;
				}

				if (event.metadata.amount === 0) {
					return;
				}

				const usageSnapshot = await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", billedUser._id))
					.first();
				if (!usageSnapshot || usageSnapshot.meter == null) {
					throw should_never_happen("Anonymous user usage snapshot not found or has no meter", {
						userId: billedUser._id,
						event,
						usageSnapshot,
					});
				}

				await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
					meter: {
						...usageSnapshot.meter,
						consumedUnits: usageSnapshot.meter!.consumedUnits + event.metadata.amount,
						balance: usageSnapshot.meter!.balance - event.metadata.amount,
					},
					lastSyncedAt: now,
				});
			}),
		);

		return null;
	},
});

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
// #endregion event ingestion

// #region admin
export const sync_products = internalAction({
	args: {},
	handler: async (ctx) => {
		await billing_polar.syncProducts(ctx);
	},
});

/** Action-friendly wrapper around `db_apply_polar_customer_state_refresh`. */
export const apply_polar_customer_state_refresh = internalMutation({
	args: {
		state: v.object({
			id: v.string(),
			externalId: v.union(v.string(), v.null()),
			deletedAt: v.union(v.string(), v.null()),
			activeSubscriptions: v.array(
				v.object({
					id: v.string(),
					productId: v.string(),
					currency: v.string(),
					currentPeriodStart: v.string(),
					currentPeriodEnd: v.string(),
					meters: v.array(
						v.object({
							meterId: v.string(),
							consumedUnits: v.number(),
							creditedUnits: v.number(),
							amount: v.number(),
						}),
					),
				}),
			),
			activeMeters: v.array(
				v.object({
					meterId: v.string(),
					consumedUnits: v.number(),
					creditedUnits: v.number(),
					balance: v.number(),
				}),
			),
		}),
		syncedAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await db_apply_polar_customer_state_refresh(ctx, { state: args.state, syncedAt: args.syncedAt });
		return null;
	},
});

/**
 * Admin-only replay of live `CustomerState` through the normal refresh flow.
 * Same-period replays are safe because the helper skips duplicate grants.
 */
export const refresh_from_polar_customer_state = internalAction({
	args: {
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const sdkState = await billing_polar.getCustomerState(ctx, { userId: args.userId });
		if (!sdkState) {
			console.info("refresh_from_polar_customer_state: no Polar customer for user", {
				userId: args.userId,
			});
			return null;
		}
		const now = Date.now();
		await ctx.runMutation(internal.billing.apply_polar_customer_state_refresh, {
			state: billing_polar_sdk_to_db_data(sdkState),
			syncedAt: now,
		});
		console.info("refresh_from_polar_customer_state ok", {
			userId: args.userId,
			polarCustomerId: sdkState.id,
			activeSubscriptionsCount: sdkState.activeSubscriptions.length,
			syncedAt: now,
		});
		return null;
	},
});

/**
 * Admin helper for adding credit to a user.
 *
 * Polar's customer meter is a sum ledger: positive event amounts are usage
 * that decreases the remaining balance, while negative event amounts are
 * credits/payments that increase it. By default, keep this action grant-only by
 * normalizing dashboard input to a negative `manual_credit` event. When
 * `allowNegative` is true, negative input is treated as a debit for QA/admin
 * drain flows.
 */
export const grant_credit = internalAction({
	args: {
		userId: v.id("users"),
		amount: v.number(),
		allowNegative: v.optional(v.boolean()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const user = await ctx.runQuery(internal.users.get, {
			userId: args.userId,
		});
		if (!user) {
			return Result({ _nay: { message: "User not found" } });
		}

		await billing_ingest_events(ctx, {
			billedUserEvents: [
				{
					billedUser: user,
					event: billing_event({
						name: "manual_credit",
						externalCustomerId: args.userId,
						externalId: composite_id("billing", "manual_credit", args.userId, Date.now()),
						metadata: {
							amount: args.allowNegative ? -args.amount : -Math.abs(args.amount),
						},
					}),
				},
			],
		});
		return Result({ _yay: null });
	},
});

export const revoke_subscription = internalAction({
	args: {
		userId: v.id("users"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const subscription = await billing_polar.getCurrentSubscription(ctx, { userId: args.userId });
		if (!subscription) {
			return Result({ _nay: { message: "Subscription not found" } });
		}

		const revokeResult = await subscriptionsRevoke(billing_polar.polar, {
			id: subscription.id,
		});
		if (!revokeResult.ok) {
			if (revokeResult.error instanceof AlreadyCanceledSubscription) {
				return Result({ _nay: { message: "Subscription already canceled" } });
			}
			if (revokeResult.error instanceof ResourceNotFound) {
				return Result({ _nay: { message: "Subscription not found" } });
			}
			throw new Error("Failed to revoke subscription", {
				cause: revokeResult.error,
			});
		}

		return Result({ _yay: null });
	},
});
// #endregion admin
