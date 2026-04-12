import { Polar } from "@convex-dev/polar";
import { Workpool } from "@convex-dev/workpool";
import { customerSessionsCreate } from "@polar-sh/sdk/funcs/customerSessionsCreate.js";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import { action, internalAction, internalMutation, query } from "./_generated/server.js";
import { billing_PRODUCTS, billing_product_matches_polar_name } from "../shared/billing.js";
import { billing_EVENTS, billing_polar_client } from "../server/billing.ts";
import { convex_error } from "../server/convex-utils.ts";
import { allowed_origins, server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
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

		if (!user.email) {
			throw convex_error({ message: "Email required for billing" });
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
 * Server-curated checkout: only the pay-as-you-go product from the shared billing registry may be purchased.
 * {@link origin} and {@link successUrl} are checked against {@link allowed_origins}.
 */
export const generate_checkout_link = action({
	args: {
		productIds: v.array(v.string()),
		origin: v.string(),
		successUrl: v.string(),
		subscriptionId: v.optional(v.string()),
		metadata: v.optional(v.record(v.string(), v.string())),
		trialInterval: v.optional(v.union(v.string(), v.null())),
		trialIntervalCount: v.optional(v.union(v.number(), v.null())),
		locale: v.optional(v.string()),
	},
	returns: v.object({
		url: v.string(),
	}),
	handler: async (ctx, args) => {
		let originParsed: URL;
		let successParsed: URL;
		try {
			originParsed = new URL(args.origin);
			successParsed = new URL(args.successUrl);
		} catch (e) {
			throw convex_error({
				message: "Invalid checkout URL",
				cause: {
					message: (e as Error).message,
				},
			});
		}

		const allowedOrigins = allowed_origins();

		if (!allowedOrigins.includes(originParsed.origin)) {
			throw convex_error({ message: "Origin is not allowed for checkout" });
		}

		const successOk = allowedOrigins.some(
			(allowedOrigin) => successParsed.origin === allowedOrigin || successParsed.href.startsWith(`${allowedOrigin}/`),
		);
		if (!successOk) {
			throw convex_error({ message: "Success URL is not allowed for checkout" });
		}

		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			throw convex_error({ message: "A signed-in account is required for checkout" });
		}
		if (!user.email) {
			throw convex_error({ message: "Email required for billing" });
		}

		const catalog =
			(await billing.listProducts(ctx)).find((product) => {
				return (
					billing_product_matches_polar_name(product.name, billing_PRODUCTS["Pay As You Go"]) && !product.isArchived
				);
			}) ?? null;
		if (!catalog) {
			throw convex_error({ message: "Checkout is not available for this deployment" });
		}

		const curatedId = catalog.id;
		if (args.productIds.length !== 1 || args.productIds[0] !== curatedId) {
			throw convex_error({ message: "Invalid checkout product" });
		}
		const { url: baseUrl } = await billing.createCheckoutSession(ctx, {
			productIds: [curatedId],
			userId: user.id,
			email: user.email,
			subscriptionId: args.subscriptionId,
			origin: args.origin,
			successUrl: args.successUrl,
			metadata: args.metadata,
			trialInterval: args.trialInterval as "day" | "week" | "month" | "year" | null | undefined,
			trialIntervalCount: args.trialIntervalCount,
		});

		let url = baseUrl;
		if (args.locale) {
			const localeUrl = new URL(url);
			localeUrl.searchParams.set("locale", args.locale);
			url = localeUrl.toString();
		}

		return { url };
	},
});

export const generate_customer_portal_url = action({
	args: {},
	returns: v.object({
		url: v.string(),
	}),
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			throw convex_error({ message: "A signed-in account is required for billing" });
		}

		const customer = await ctx.runQuery(components.polar.lib.getCustomerByUserId, {
			userId: user.id,
		});
		if (!customer) {
			throw convex_error({ message: "Customer not found" });
		}

		const session = await customerSessionsCreate(billing.polar, {
			customerId: customer.id,
		});
		if (!session.ok) {
			throw session.error;
		}

		return { url: session.value.customerPortalUrl };
	},
});

export const change_current_subscription = action({
	args: {
		productId: v.string(),
	},
	handler: async () => {
		throw new Error("Plan changes are not supported");
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
// #endregion admin
