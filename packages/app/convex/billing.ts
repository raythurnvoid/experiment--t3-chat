import { Polar } from "@convex-dev/polar";
import { Workpool } from "@convex-dev/workpool";
import type { CustomerState } from "@polar-sh/sdk/models/components/customerstate.js";
import { customersGetState } from "@polar-sh/sdk/funcs/customersGetState.js";
import { customerSessionsCreate } from "@polar-sh/sdk/funcs/customerSessionsCreate.js";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server.js";
import { BILLING_PRODUCTS, billing_product_matches_polar_name } from "../shared/billing.js";
import { billing_EVENTS, billing_polar_client } from "../server/billing.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

if (!process.env.POLAR_SERVER) {
	throw new Error("POLAR_SERVER is not set");
}

const POLAR_SERVER = process.env.POLAR_SERVER as "sandbox" | "production";

if (!process.env.ALLOWED_ORIGINS) {
	throw new Error("ALLOWED_ORIGINS is not set");
}

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

/**
 * Single Polar client for this app: register webhook routes on this instance only, and use
 * {@link billing.api} exports for Convex functions (see @convex-dev/polar README).
 */
export const billing = new Polar<DataModel>(components.polar, {
	getUserInfo: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx as QueryCtx | ActionCtx);

		if (!user || user.kind !== "signed_in") {
			throw new ConvexError("Billing requires a signed-in account");
		}

		if (!user.email) {
			throw new ConvexError("Email required for billing");
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

export const billing_refresh_workpool = new Workpool(components.billingRefreshWorkpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
});

export type BillingProductRow = NonNullable<Awaited<ReturnType<typeof billing.listProducts>>[number]>;
type BillingPayAsYouGoProductRow = BillingProductRow;
export const get_pay_as_you_go_product = internalQuery({
	args: {},
	handler: async (ctx): Promise<BillingPayAsYouGoProductRow | null> => {
		const products = await billing.listProducts(ctx);
		return (
			products.find((product) => {
				return billing_product_matches_polar_name(product.name, BILLING_PRODUCTS["Pay As You Go"]) && !product.isArchived;
			}) ?? null
		);
	},
});

function billing_payg_meter_id_and_name_from_product(product: BillingPayAsYouGoProductRow) {
	const price = product.prices?.find((priceRow) => !priceRow.isArchived);
	if (!price) {
		return null;
	}

	return price.meter ?? null;
}

type BillingSnapshotWrite = Omit<Doc<"billing_usage_snapshots">, "_id" | "_creationTime" | "lastError">;

type BillingUsageOverviewSnapshotFields = Pick<
	Doc<"billing_usage_snapshots">,
	| "meterId"
	| "meterName"
	| "consumedUnits"
	| "creditedUnits"
	| "balance"
	| "amountDueCents"
	| "currency"
	| "currentPeriodStart"
	| "currentPeriodEnd"
	| "lastSyncedAt"
>;

/**
 * Map Polar {@link CustomerState} to a snapshot row for the curated pay-as-you-go product.
 * Return `null` when the customer has zero, multiple, or unmetered PAYG subscriptions in Polar state.
 */
export function billing_usage_snapshot_fields_from_customer_state(args: {
	customerState: CustomerState;
	paygProductId: string;
	preferredMeterId: string | null;
	preferredMeterName: string | null;
	userId: Id<"users">;
	polarCustomerId: string;
	now: number;
}): BillingSnapshotWrite | null {
	const { customerState, paygProductId, preferredMeterId, preferredMeterName, userId, polarCustomerId, now } = args;
	const paygSubs = customerState.activeSubscriptions.filter((s) => s.productId === paygProductId);
	if (paygSubs.length !== 1) {
		return null;
	}
	const sub = paygSubs[0]!;
	if (!sub.meters.length) {
		return null;
	}
	const meterRow =
		(preferredMeterId ? sub.meters.find((m) => m.meterId === preferredMeterId) : undefined) ?? sub.meters[0]!;
	const activeMeter = customerState.activeMeters.find((m) => m.meterId === meterRow.meterId);
	const balance = activeMeter?.balance ?? meterRow.creditedUnits - meterRow.consumedUnits;
	const meterName =
		preferredMeterId != null && preferredMeterId === meterRow.meterId
			? preferredMeterName
			: sub.meters.length === 1
				? preferredMeterName
				: null;
	return {
		userId,
		polarCustomerId,
		subscriptionId: sub.id,
		productId: sub.productId,
		meterId: meterRow.meterId,
		meterName,
		consumedUnits: meterRow.consumedUnits,
		creditedUnits: meterRow.creditedUnits,
		balance,
		amountDueCents: meterRow.amount,
		currency: sub.currency,
		currentPeriodStart: sub.currentPeriodStart.toISOString(),
		currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
		lastSyncedAt: now,
	};
}

export type BillingUsageOverview = BillingUsageOverviewSnapshotFields | null;
export type BillingSubscriptionRow = NonNullable<Awaited<ReturnType<typeof billing.listAllUserSubscriptions>>[number]>;

export const get_usage = query({
	args: {},
	returns: v.union(
		v.null(),
		v.object({
			meterId: v.string(),
			meterName: v.union(v.string(), v.null()),
			consumedUnits: v.number(),
			creditedUnits: v.number(),
			balance: v.number(),
			amountDueCents: v.number(),
			currency: v.string(),
			currentPeriodStart: v.string(),
			currentPeriodEnd: v.string(),
			lastSyncedAt: v.number(),
		}),
	),
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			return null;
		}

		const snap = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_userId", (q) => q.eq("userId", user.id))
			.unique();
		if (!snap) {
			return null;
		}

		return {
			meterId: snap.meterId,
			meterName: snap.meterName,
			consumedUnits: snap.consumedUnits,
			creditedUnits: snap.creditedUnits,
			balance: snap.balance,
			amountDueCents: snap.amountDueCents,
			currency: snap.currency,
			currentPeriodStart: snap.currentPeriodStart,
			currentPeriodEnd: snap.currentPeriodEnd,
			lastSyncedAt: snap.lastSyncedAt,
		};
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

export const list_all_subscriptions = query({
	args: {},
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			return [];
		}

		return await billing.listAllUserSubscriptions(ctx, { userId: user.id });
	},
});

export const delete_usage_snapshot = internalMutation({
	args: {
		userId: v.id("users"),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_userId", (q) => q.eq("userId", args.userId))
			.unique();
		if (existing) {
			await ctx.db.delete("billing_usage_snapshots", existing._id);
		}
	},
});

export const upsert_usage_snapshot = internalMutation({
	args: {
		row: v.object({
			userId: v.id("users"),
			polarCustomerId: v.string(),
			subscriptionId: v.string(),
			productId: v.string(),
			meterId: v.string(),
			meterName: v.union(v.string(), v.null()),
			consumedUnits: v.number(),
			creditedUnits: v.number(),
			balance: v.number(),
			amountDueCents: v.number(),
			currency: v.string(),
			currentPeriodStart: v.string(),
			currentPeriodEnd: v.string(),
			lastSyncedAt: v.number(),
		}),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_userId", (q) => q.eq("userId", args.row.userId))
			.unique();
		const payload: BillingSnapshotWrite & { lastError: null } = { ...args.row, lastError: null };
		if (existing) {
			await ctx.db.patch("billing_usage_snapshots", existing._id, payload);
		} else {
			await ctx.db.insert("billing_usage_snapshots", payload);
		}
	},
});

export const refresh_usage_snapshot = internalAction({
	args: {
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();
		const product = (await billing.listProducts(ctx)).find((product) => {
			return billing_product_matches_polar_name(product.name, BILLING_PRODUCTS["Pay As You Go"]) && !product.isArchived;
		});
		if (!product) {
			await ctx.runMutation(internal.billing.delete_usage_snapshot, {
				userId: args.userId,
			});
			return null;
		}
		const paygId = product.id;
		const meter = billing_payg_meter_id_and_name_from_product(product);

		if (!meter) {
			await ctx.runMutation(internal.billing.delete_usage_snapshot, {
				userId: args.userId,
			});
			return null;
		}

		const customer = await ctx.runQuery(components.polar.lib.getCustomerByUserId, {
			userId: args.userId,
		});
		let customerState = null;
		if (customer) {
			const customer_state_result = await customersGetState(billing.polar, {
				id: customer.id,
			});
			if (!customer_state_result.ok) {
				throw customer_state_result.error;
			}
			customerState = customer_state_result.value;
		}

		let fields;
		if (customerState) {
			fields = billing_usage_snapshot_fields_from_customer_state({
				customerState,
				paygProductId: paygId,
				preferredMeterId: meter.id,
				preferredMeterName: meter.name,
				userId: args.userId,
				polarCustomerId: customerState.id,
				now,
			});
		}

		if (!fields) {
			await ctx.runMutation(internal.billing.delete_usage_snapshot, {
				userId: args.userId,
			});
		} else {
			await ctx.runMutation(internal.billing.upsert_usage_snapshot, {
				row: fields,
			});
		}

		return null;
	},
});

function billing_checkout_callback_urls_allowed(origin: string, successUrl: string) {
	let originParsed: URL;
	let successParsed: URL;
	try {
		originParsed = new URL(origin);
		successParsed = new URL(successUrl);
	} catch {
		throw new Error("Invalid checkout URL");
	}

	const allowedOrigins: string[] = [];
	for (const part of ALLOWED_ORIGINS.split(",")) {
		try {
			allowedOrigins.push(new URL(part).origin);
		} catch {}
	}

	if (!allowedOrigins.includes(originParsed.origin)) {
		throw new Error("Origin is not allowed for checkout");
	}

	const successOk = allowedOrigins.some(
		(allowedOrigin) => successParsed.origin === allowedOrigin || successParsed.href.startsWith(`${allowedOrigin}/`),
	);
	if (!successOk) {
		throw new Error("Success URL is not allowed for checkout");
	}
}

/**
 * Server-curated checkout: only the pay-as-you-go product from the shared billing registry may be purchased.
 * {@link origin} and {@link successUrl} are checked against {@link ALLOWED_ORIGINS}.
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
		billing_checkout_callback_urls_allowed(args.origin, args.successUrl);

		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			throw new ConvexError("A signed-in account is required for checkout");
		}
		if (!user.email) {
			throw new ConvexError("Email required for billing");
		}

		const catalog = await ctx.runQuery(internal.billing.get_pay_as_you_go_product, {});
		if (!catalog) {
			throw new ConvexError("Checkout is not available for this deployment");
		}

		const curatedId = catalog.id;
		if (args.productIds.length !== 1 || args.productIds[0] !== curatedId) {
			throw new ConvexError("Invalid checkout product");
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
			throw new ConvexError("A signed-in account is required for billing");
		}

		const customer = await ctx.runQuery(components.polar.lib.getCustomerByUserId, {
			userId: user.id,
		});
		if (!customer) {
			throw new ConvexError("Customer not found");
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

export const list_all_products = internalQuery({
	args: {},
	handler: async (ctx) => {
		return await billing.listProducts(ctx);
	},
});

/**
 * Run from repo: `pnpm exec convex run internal.billing.sync_products` (cwd: packages/app).
 **/
export const sync_products = internalAction({
	args: {},
	handler: async (ctx) => {
		await billing.syncProducts(ctx);
	},
});

// #region event ingestion
export async function billing_db_ingest_page_save(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		pageId: Id<"pages">;
		workspaceId: string;
		projectId: string;
		newSequence: number;
	},
) {
	const eventName = billing_EVENTS.pressUsage;
	const eventId = `${eventName}:${args.userId}:${args.pageId}:${args.newSequence}`;
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
