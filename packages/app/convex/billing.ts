import { Polar } from "@convex-dev/polar";
import { Workpool } from "@convex-dev/workpool";
import { customersCreate } from "@polar-sh/sdk/funcs/customersCreate.js";
import { customerSessionsCreate } from "@polar-sh/sdk/funcs/customerSessionsCreate.js";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { subscriptionsCreate } from "@polar-sh/sdk/funcs/subscriptionsCreate.js";
import { subscriptionsRevoke } from "@polar-sh/sdk/funcs/subscriptionsRevoke.js";
import { subscriptionsUpdate } from "@polar-sh/sdk/funcs/subscriptionsUpdate.js";
import { AlreadyCanceledSubscription } from "@polar-sh/sdk/models/errors/alreadycanceledsubscription.js";
import { PaymentFailed } from "@polar-sh/sdk/models/errors/paymentfailed.js";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound.js";
import { SubscriptionLocked } from "@polar-sh/sdk/models/errors/subscriptionlocked.js";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import { action, internalAction, internalMutation, query } from "./_generated/server.js";
import { Result, Result_try_async } from "../shared/errors-as-values-utils.ts";
import { billing_PRODUCTS, billing_get_plan_change_kind } from "../shared/billing.ts";
import { billing_EVENTS, billing_polar_client } from "../server/billing.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { allowed_origins, server_convex_get_user_fallback_to_anonymous, should_never_happen } from "../server/server-utils.ts";
import { convertToDatabaseSubscription } from "../vendor/polar/src/component/util.ts";
import app_convex_schema from "./schema.ts";

if (!process.env.POLAR_SERVER) {
	throw new Error("POLAR_SERVER is not set");
}

const POLAR_SERVER = process.env.POLAR_SERVER as "sandbox" | "production";

/**
 * Single Polar client for this app: register webhook routes on this instance only, and use
 * {@link billing.api} exports for Convex functions (see @convex-dev/polar README).
 */
export const billing = new Polar<DataModel>(components.polar, {
	getUserInfo: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx as QueryCtx | ActionCtx);

		if (!user || user.kind !== "signed_in") {
			throw convex_error({ message: "Billing requires a signed-in account" });
		}

		return { userId: user.id, email: user.email };
	},
	server: POLAR_SERVER,
});

const billing_api = billing.api();

const billing_usage_event_workpool = new Workpool(components.billingUsageEventWorkpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
});

export const get_usage_snapshot = query({
	args: {},
	returns: v.union(v.null(), doc(app_convex_schema, "billing_usage_snapshots")),
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			return null;
		}

		const snap = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_userId", (q) => q.eq("userId", user.id))
			.first();

		return snap;
	},
});

export const list_products = query({
	args: {},
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			return [];
		}

		return await billing.listProducts(ctx);
	},
});

export const list_subscriptions = query({
	args: {},
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			return [];
		}

		return await billing.listAllUserSubscriptions(ctx, { userId: user.id });
	},
});

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
			data: {
				id: string;
				external_id?: string | null;
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
					balance: number;
				}>;
			};
		};
		const userId = payload.data.external_id as Id<"users">;
		const subscription = payload.data.active_subscriptions[0];
		const meterRow = subscription?.meters[0];
		const activeMeter = meterRow
			? payload.data.active_meters.find((meter) => meter.meter_id === meterRow.meter_id)
			: null;

		const usageSnapshot = {
			userId,
			polarCustomerId: payload.data.id,
			subscription: subscription
				? {
						id: subscription.id,
						productId: subscription.product_id,
						currency: subscription.currency,
						currentPeriodStart: subscription.current_period_start,
						currentPeriodEnd: subscription.current_period_end,
					}
				: null,
			meter: meterRow
				? {
						id: meterRow.meter_id,
						consumedUnits: meterRow.consumed_units,
						creditedUnits: meterRow.credited_units,
						balance: activeMeter?.balance ?? meterRow.credited_units - meterRow.consumed_units,
						amountDueCents: meterRow.amount,
					}
				: null,
			lastSyncedAt: Date.parse(payload.timestamp),
		} satisfies Omit<Doc<"billing_usage_snapshots">, "_id" | "_creationTime">;

		const existing = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.unique();
		if (existing) {
			await ctx.db.patch("billing_usage_snapshots", existing._id, usageSnapshot);
		} else {
			await ctx.db.insert("billing_usage_snapshots", usageSnapshot);
		}

		return null;
	},
});

/**
 * Checkout for a single Polar product id synced into this deployment. The product must exist in {@link billing.listProducts} and
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

		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			return Result({ _nay: { message: "A signed-in account is required for checkout" } });
		}

		const product =
			(await billing.listProducts(ctx)).find((product) => {
				return product.id === args.productId && !product.isArchived;
			}) ?? null;
		if (!product) {
			return Result({ _nay: { message: "Invalid checkout product" } });
		}

		const checkoutSessionResult = await Result_try_async(() =>
			billing.createCheckoutSession(ctx, {
				productIds: [product.id],
				userId: user.id,
				email: user.email,
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
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			return Result({ _nay: { message: "A signed-in account is required for billing" } });
		}

		const customer = await ctx.runQuery(components.polar.lib.getCustomerByUserId, {
			userId: user.id,
		});
		if (!customer) {
			return Result({ _nay: { message: "Customer not found" } });
		}

		const session = await customerSessionsCreate(billing.polar, {
			customerId: customer.id,
		});
		if (!session.ok) {
			return Result({ _nay: { message: "Failed to create customer portal session" } });
		}

		return Result({ _yay: { url: session.value.customerPortalUrl } });
	},
});

// #region bootstrap
const billing_bootstrap_workpool = new Workpool(components.billingBootstrapWorkpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
});

export async function billing_enqueue_free_subscription_bootstrap(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		email: string;
	},
) {
	return await billing_bootstrap_workpool.enqueueAction(ctx, internal.billing.bootstrap_free_subscription, args);
}

export const bootstrap_free_subscription = internalAction({
	args: {
		userId: v.id("users"),
		email: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const bootstrapResult = await Result_try_async(async () => {
			let customer = await ctx.runQuery(components.polar.lib.getCustomerByUserId, {
				userId: args.userId,
			});

			if (!customer) {
				const createCustomerResult = await customersCreate(billing.polar, {
					externalId: args.userId,
					email: args.email,
				});
				if (!createCustomerResult.ok) {
					throw convex_error({ message: "Failed to create Polar customer" });
				}

				await ctx.runMutation(components.polar.lib.insertCustomer, {
					id: createCustomerResult.value.id,
					userId: args.userId,
				});

				customer = await ctx.runQuery(components.polar.lib.getCustomerByUserId, {
					userId: args.userId,
				});
			}

			if (!customer) {
				throw should_never_happen("Failed to persist Polar customer", {
					userId: args.userId,
				});
			}

			const currentSubscription = await ctx.runQuery(components.polar.lib.getCurrentSubscription, {
				userId: args.userId,
			});
			if (currentSubscription) {
				return;
			}

			const freeProduct =
				(await billing.listProducts(ctx)).find((product) => {
					return product.name === billing_PRODUCTS.Free.name && !product.isArchived;
				}) ?? null;
			if (!freeProduct) {
				throw should_never_happen("Free product not found among synced Polar products", {
					productName: billing_PRODUCTS.Free.name,
					userId: args.userId,
				});
			}

			const createSubscriptionResult = await subscriptionsCreate(billing.polar, {
				customerId: customer.id,
				productId: freeProduct.id,
			});
			if (!createSubscriptionResult.ok) {
				throw convex_error({ message: "Failed to create Free subscription" });
			}

			await ctx.runMutation(components.polar.lib.createSubscription, {
				subscription: convertToDatabaseSubscription(createSubscriptionResult.value),
			});
		});
		if (bootstrapResult._nay) {
			console.error("[billing.bootstrap_free_subscription] Failed to bootstrap Free subscription", {
				error: bootstrapResult._nay,
				userId: args.userId,
			});
			throw convex_error({ message: "Failed to bootstrap Free subscription" });
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
		_yay: v.object({
			changeKind: v.union(v.literal("upgrade"), v.literal("downgrade")),
			prorationBehavior: v.union(v.literal("invoice"), v.literal("next_period")),
			targetProductId: v.string(),
			pendingUpdateAppliesAt: v.union(v.string(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			return Result({ _nay: { message: "A signed-in account is required for billing" } });
		}

		const currentSubscription = await ctx.runQuery(components.polar.lib.getCurrentSubscription, {
			userId: user.id,
		});
		if (!currentSubscription || (currentSubscription.status !== "active" && currentSubscription.status !== "trialing")) {
			return Result({ _nay: { message: "No active subscription found" } });
		}

		const targetProduct =
			(await billing.listProducts(ctx)).find((product) => {
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

		const prorationBehavior = changeKind === "upgrade" ? "invoice" : "next_period";
		const updateResult = await subscriptionsUpdate(billing.polar, {
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

			console.error("[billing.change_current_subscription] Failed to change the subscription", {
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

		await ctx.runMutation(components.polar.lib.updateSubscription, {
			subscription: convertToDatabaseSubscription(updateResult.value),
		});

		return Result({
			_yay: {
				changeKind,
				prorationBehavior,
				targetProductId: targetProduct.id,
				pendingUpdateAppliesAt: updateResult.value.pendingUpdate?.appliesAt.toISOString() ?? null,
			},
		});
	},
});

export const cancel_current_subscription = billing_api.cancelCurrentSubscription;

// #region event ingestion
export async function billing_ingest_page_save(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		pageId: Id<"pages">;
		workspaceId: string;
		projectId: string;
		newSequence: number;
	},
) {
	// Skip async billing side effects under tests because `convex-test` does not
	// keep the workpool scheduler lifecycle alive after the enclosing transaction.
	if (process.env.NODE_ENV === "test") {
		return;
	}

	const eventId = `${billing_EVENTS.pressUsage}:${args.userId}:${args.pageId}:${args.newSequence}`;

	await billing_usage_event_workpool.enqueueAction(ctx, internal.billing.ingest_usage_event, {
		userId: args.userId,
		eventId,
		metadata: {
			amount: 1,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			pageId: args.pageId,
			yjsSequence: String(args.newSequence),
			source: "page-save",
		},
	});
}

export const ingest_usage_event = internalAction({
	args: {
		userId: v.id("users"),
		eventId: v.string(),
		metadata: v.record(v.string(), v.union(v.string(), v.number())),
	},
	handler: async (_ctx, args) => {
		const ingestResult = await eventsIngest(billing_polar_client(), {
			events: [
				{
					name: billing_EVENTS.pressUsage,
					externalCustomerId: args.userId,
					externalId: args.eventId,
					metadata: args.metadata,
				},
			],
		});
		if (!ingestResult.ok) {
			throw new Error(JSON.stringify(ingestResult.error));
		}
	},
});
// #endregion event ingestion

// #region admin
export const sync_products = internalAction({
	args: {},
	handler: async (ctx) => {
		await billing.syncProducts(ctx);
	},
});

export const grant_credit = internalAction({
	args: {
		userId: v.id("users"),
		amount: v.number(),
	},
	returns: v.null(),
	handler: async (_ctx, args) => {
		const ingestResult = await eventsIngest(billing_polar_client(), {
			events: [
				{
					name: billing_EVENTS.pressUsage,
					externalCustomerId: args.userId,
					externalId: `grant-credit:${args.userId}:${Date.now()}`,
					metadata: {
						amount: -Math.abs(args.amount),
						source: "manual-credit",
					},
				},
			],
		});
		if (!ingestResult.ok) {
			throw new Error(JSON.stringify(ingestResult.error));
		}
		return null;
	},
});

export const revoke_subscription = internalAction({
	args: {
		userId: v.id("users"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const subscription = await ctx.runQuery(components.polar.lib.getCurrentSubscription, {
			userId: args.userId,
		});
		if (!subscription) {
			return Result({ _nay: { message: "Subscription not found" } });
		}

		const revokeResult = await subscriptionsRevoke(billing.polar, {
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
