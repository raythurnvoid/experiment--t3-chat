import { Polar } from "@convex-dev/polar";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import { customersCreate } from "@polar-sh/sdk/funcs/customersCreate.js";
import { customersDelete } from "@polar-sh/sdk/funcs/customersDelete.js";
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
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server.js";
import { Result, Result_try_async } from "../shared/errors-as-values-utils.ts";
import {
	billing_PRODUCTS,
	billing_get_plan_change_kind,
	billing_get_recurring_credits_cents,
} from "../shared/billing.ts";
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

const billing_workpool_usage_event = new Workpool(components.billing_workpool_usage_event, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 10 * 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

export async function billing_action_clear_subscriptions_by_user_id(
	ctx: ActionCtx | MutationCtx,
	args: {
		userId: Id<"users">;
	},
) {
	await ctx.runMutation(components.polar.lib.clearSubscriptionsByUserId, {
		userId: args.userId,
	});
}

export async function billing_action_delete_polar_customer_by_user_id(
	ctx: ActionCtx | MutationCtx,
	args: {
		userId: Id<"users">;
	},
) {
	const customer = await ctx.runQuery(components.polar.lib.getCustomerByUserId, {
		userId: args.userId,
	});
	if (!customer) {
		return Result({ _yay: null });
	}

	const deleteResult = await customersDelete(billing_polar_client(), {
		id: customer.id,
		anonymize: true,
	});
	if (!deleteResult.ok && !(deleteResult.error instanceof ResourceNotFound)) {
		return Result({
			_nay: {
				message: "Failed to delete Polar customer",
				cause: deleteResult.error,
			},
		});
	}

	await ctx.runMutation(components.polar.lib.deleteCustomerByUserId, {
		userId: args.userId,
	});

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

export async function billing_action_cancel_polar_subscription_at_period_end(args: { subscriptionId: string }) {
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

export const get_current_user_subscription = query({
	args: {},
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			return null;
		}

		const currentSubscription = await ctx.runQuery(components.polar.lib.getCurrentSubscription, {
			userId: user.id,
		});
		if (!currentSubscription) {
			return null;
		}

		const { product, ...subscription } = currentSubscription;
		return subscription;
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
					consumed_units: number;
					credited_units: number;
					balance: number;
				}>;
			};
		};
		const userId = payload.data.external_id as Id<"users">;
		if (payload.data.active_subscriptions.length > 1) {
			throw should_never_happen("Multiple active subscriptions are not supported", {
				activeSubscriptions: payload.data.active_subscriptions,
				customerId: payload.data.id,
				userId,
			});
		}

		const subscription = payload.data.active_subscriptions[0];
		const product = subscription
			? await ctx.runQuery(components.polar.lib.getProduct, {
					id: subscription.product_id,
				})
			: null;
		const meteredPrice =
			product?.prices?.find((price) => {
				return !price.isArchived && price.amountType === "metered_unit";
			}) ?? null;
		const creditBenefit =
			meteredPrice == null
				? (product?.benefits?.find((benefit) => {
						return benefit.type === "meter_credit";
					}) ?? null)
				: null;
		const creditBenefitMeterId =
			typeof creditBenefit?.properties === "object" &&
			creditBenefit.properties !== null &&
			"meterId" in creditBenefit.properties &&
			typeof creditBenefit.properties.meterId === "string"
				? creditBenefit.properties.meterId
				: null;
		const meterRow = subscription?.meters[0] ?? null;
		const activeMeter = meterRow
			? (payload.data.active_meters.find((meter) => meter.meter_id === meterRow.meter_id) ?? null)
			: creditBenefitMeterId
				? (payload.data.active_meters.find((meter) => meter.meter_id === creditBenefitMeterId) ?? null)
				: null;
		const usageMeter = meterRow
			? {
					id: meterRow.meter_id,
					consumedUnits: meterRow.consumed_units,
					creditedUnits: meterRow.credited_units,
					balance: activeMeter?.balance ?? meterRow.credited_units - meterRow.consumed_units,
					amountDueCents: meterRow.amount,
				}
			: creditBenefitMeterId && activeMeter
				? {
						id: creditBenefitMeterId,
						consumedUnits: activeMeter.consumed_units,
						creditedUnits: activeMeter.credited_units,
						balance: activeMeter.balance,
						amountDueCents: 0,
					}
				: null;

		if (subscription && usageMeter == null) {
			throw should_never_happen("Failed to resolve usage meter for active subscription", {
				activeMeters: payload.data.active_meters,
				customerId: payload.data.id,
				product,
				subscription,
				userId,
			});
		}

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
			meter: usageMeter,
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

		// Queue the monthly credits engine on every active-subscription state
		// change so renewals and upgrades grant credits as soon as Polar reports
		// the new period.
		if (subscription) {
			await billing_workpool_usage_event.enqueueAction(ctx, internal.billing.grant_monthly_credits, {
				userId,
				subscriptionId: subscription.id,
				productId: subscription.product_id,
				periodStart: subscription.current_period_start,
			});
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
				.withIndex("by_userId", (q) => q.eq("userId", args.userId))
				.first()) ?? null
		);
	},
});

export const upsert_cancel_polar_subscription_job = internalMutation({
	args: {
		userId: v.id("users"),
		jobId: v.string(),
		updatedAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existingRows = await ctx.db
			.query("billing_cancel_polar_subscription_jobs")
			.withIndex("by_userId", (q) => q.eq("userId", args.userId))
			.collect();
		const [currentRow, ...staleRows] = existingRows;

		await Promise.all(staleRows.map((row) => ctx.db.delete("billing_cancel_polar_subscription_jobs", row._id)));

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
		const rows = await ctx.db
			.query("billing_cancel_polar_subscription_jobs")
			.withIndex("by_userId", (q) => q.eq("userId", args.userId))
			.collect();

		await Promise.all(rows.map((row) => ctx.db.delete("billing_cancel_polar_subscription_jobs", row._id)));

		return null;
	},
});

export const complete_polar_subscription_period_end_cancellation = billing_workpool_cancellation.defineOnComplete({
	context: v.object({
		userId: v.id("users"),
	}),
	handler: async (ctx, args) => {
		const userId = args.context.userId as Id<"users">;
		const row = await ctx.db
			.query("billing_cancel_polar_subscription_jobs")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.first();
		if (!row || row.jobId !== args.workId) {
			return;
		}

		if (args.result.kind === "success") {
			await ctx.db.delete(
				"billing_cancel_polar_subscription_jobs",
				row._id as Id<"billing_cancel_polar_subscription_jobs">,
			);
		}

		return;
	},
});

export async function billing_schedule_polar_subscription_period_end_cancellation(
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
		await billing_workpool_cancellation.cancel(ctx, existingRow.jobId as WorkId);
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

export async function billing_cancel_scheduled_polar_subscription_period_end_cancellation(
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

	await billing_workpool_cancellation.cancel(ctx, existingRow.jobId as WorkId);
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
		await billing_schedule_polar_subscription_period_end_cancellation(ctx, args);

		return null;
	},
});

export const cancel_scheduled_polar_subscription_period_end_cancellation = internalAction({
	args: {
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		return await billing_cancel_scheduled_polar_subscription_period_end_cancellation(ctx, args);
	},
});

export const cancel_polar_subscription_at_period_end = internalAction({
	args: {
		userId: v.id("users"),
		subscriptionId: v.string(),
	},
	returns: v.null(),
	handler: async (_ctx, args) => {
		const cancelSubscriptionResult = await billing_action_cancel_polar_subscription_at_period_end({
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

export async function billing_enqueue_free_subscription_bootstrap(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		email: string;
	},
) {
	return await billing_workpool_bootstrap.enqueueAction(ctx, internal.billing.bootstrap_free_subscription, args);
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
					throw convex_error({
						message: "Failed to create Polar customer",
						cause: createCustomerResult.error,
						data: {
							email: args.email,
							userId: args.userId,
						},
					});
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
		if (
			!currentSubscription ||
			(currentSubscription.status !== "active" && currentSubscription.status !== "trialing")
		) {
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
export const ingest_events = internalAction({
	args: {
		events: v.array(
			v.union(
				v.object({
					name: v.literal("page_save"),
					externalCustomerId: v.id("users"),
					externalId: v.string(),
					metadata: v.object({
						amount: v.number(),
						workspaceId: v.string(),
						projectId: v.string(),
						pageId: v.string(),
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
					name: v.literal("manual_credit"),
					externalCustomerId: v.id("users"),
					externalId: v.string(),
					metadata: v.object({
						amount: v.number(),
					}),
				}),
			),
		),
	},
	handler: async (_ctx, args) => {
		// Skip direct Polar calls in tests; tests assert queued payloads at the
		// workpool boundary unless they explicitly opt into this action path.
		if (process.env.NODE_ENV === "test") {
			return;
		}

		// Polar tracks all billing effects in one meter; keep the app event name as
		// metadata while passing the rest of the Polar-shaped event through.
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

/**
 * Queue app-owned billing events for Polar ingestion.
 *
 * Keep this as the only local entrypoint for usage-event emission so every
 * caller gets the workpool retry behavior before `ingest_events` performs
 * the actual Polar `eventsIngest` call.
 */
export async function billing_ingest_events(
	ctx: ActionCtx | MutationCtx,
	args: {
		events: Array<billing_Event>;
	},
) {
	// Keep every billing event ingest behind the workpool so Polar failures are
	// retried by one queue regardless of the caller runtime.
	return await billing_workpool_usage_event.enqueueAction(ctx, internal.billing.ingest_events, {
		events: args.events,
	});
}
// #endregion event ingestion

// #region monthly credits
/**
 * Grant recurring monthly credits for one `(user, subscription, period)` tuple.
 *
 * The Convex monthly credits engine is the only code path that grants recurring
 * credits for every plan (Free, Pay As You Go, Pro). Polar `meter_credit`
 * benefits are detached from products in the dashboard so they cannot fire in
 * parallel. The Polar usage event keyed by `externalId` is the authority for
 * whether this period was already granted.
 */
export const grant_monthly_credits = internalAction({
	args: {
		userId: v.id("users"),
		subscriptionId: v.string(),
		productId: v.string(),
		periodStart: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const product = await ctx.runQuery(components.polar.lib.getProduct, {
			id: args.productId,
		});
		if (!product) {
			throw should_never_happen("Product not found while granting monthly credits", {
				periodStart: args.periodStart,
				productId: args.productId,
				subscriptionId: args.subscriptionId,
				userId: args.userId,
			});
		}

		const recurringAmountCents = billing_get_recurring_credits_cents(product.name);
		if (recurringAmountCents > 0) {
			// Use a deterministic externalId so Polar records one immutable credit
			// event per `(user, subscription, period)` tuple and reports later
			// retries as duplicates.
			await billing_ingest_events(ctx, {
				events: [
					billing_event({
						name: "monthly_credit",
						externalCustomerId: args.userId,
						externalId: composite_id(
							"billing",
							"monthly_credit",
							args.userId,
							args.subscriptionId,
							args.periodStart,
						),
						metadata: {
							amount: -recurringAmountCents,
							subscriptionId: args.subscriptionId,
							productId: args.productId,
							productName: product.name,
							periodStart: args.periodStart,
						},
					}),
				],
			});
		}

		return null;
	},
});
// #endregion monthly credits

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
	handler: async (ctx, args) => {
		await billing_ingest_events(ctx, {
			events: [
				billing_event({
					name: "manual_credit",
					externalCustomerId: args.userId,
					externalId: composite_id("billing", "manual_credit", args.userId, Date.now()),
					metadata: {
						amount: -Math.abs(args.amount),
					},
				}),
			],
		});
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
