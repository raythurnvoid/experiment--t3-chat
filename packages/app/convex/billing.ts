import { Polar } from "@convex-dev/polar";
import { PolarCore } from "@polar-sh/sdk/core.js";
import type { CustomerState } from "@polar-sh/sdk/models/components/customerstate.js";
import { customersGetState } from "@polar-sh/sdk/funcs/customersGetState.js";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server.js";
import { BILLING_EVENTS, PRODUCTS } from "../shared/billing.js";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

if (!process.env.POLAR_PRODUCTS_PREFIX) {
	throw new Error("POLAR_PRODUCTS_PREFIX is not set");
}

const POLAR_PRODUCTS_PREFIX = process.env.POLAR_PRODUCTS_PREFIX;

if (!process.env.POLAR_SERVER) {
	throw new Error("POLAR_SERVER is not set");
}

const POLAR_SERVER = process.env.POLAR_SERVER as "sandbox" | "production";

if (!process.env.POLAR_ORGANIZATION_TOKEN) {
	throw new Error("POLAR_ORGANIZATION_TOKEN is not set");
}

const POLAR_ORGANIZATION_TOKEN = process.env.POLAR_ORGANIZATION_TOKEN;

if (!process.env.ALLOWED_ORIGINS) {
	throw new Error("ALLOWED_ORIGINS is not set");
}

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

const BILLING_OUTBOX_MAX_DRAIN_PER_RUN = 24;

/** Align refresh hints with Polar docs (~1–5 minutes). */
export const BILLING_USAGE_SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Single Polar client for this app: register webhook routes on this instance only, and use
 * {@link billing.api} exports for Convex functions (see @convex-dev/polar README).
 */
export const billing = new Polar<DataModel>(components.polar, {
	getUserInfo: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx as QueryCtx | ActionCtx);

		if (!user || user.kind !== "signed_in") {
			throw new Error("Billing requires a signed-in account");
		}

		if (!user.email) {
			throw new Error("Email required for billing");
		}

		return { userId: user.id, email: user.email };
	},
	server: POLAR_SERVER,
});

const billing_api = billing.api();

function billing_resolve_checkout_product_name() {
	return `${POLAR_PRODUCTS_PREFIX}-${PRODUCTS.PAY_AS_YOU_GO}`;
}

async function billing_get_customer_state(ctx: QueryCtx | ActionCtx, userId: string) {
	const customer = await ctx.runQuery(components.polar.lib.getCustomerByUserId, {
		userId,
	});
	if (!customer) {
		return null;
	}
	const stateResult = await customersGetState(billing.polar, { id: customer.id });
	if (!stateResult.ok) {
		throw stateResult.error;
	}
	return stateResult.value;
}

type BillingPayAsYouGoProductRow = NonNullable<Awaited<ReturnType<typeof billing.listProducts>>[number]>;

type BillingPayAsYouGoQueryResult =
	| {
			setup: "ready";
			payAsYouGo: BillingPayAsYouGoProductRow;
	  }
	| {
			setup: "product_not_in_catalog";
			expectedProductName: string;
	  }
	| {
			setup: "duplicate_product_name";
			expectedProductName: string;
	  };

type BillingPayAsYouGoResolution =
	| { setup: "ready"; payAsYouGo: BillingPayAsYouGoProductRow }
	| { setup: "product_not_in_catalog"; expectedProductName: string }
	| { setup: "duplicate_product_name"; expectedProductName: string };

async function billing_try_resolve_pay_as_you_go_product(
	ctx: QueryCtx | ActionCtx,
): Promise<BillingPayAsYouGoResolution> {
	const expectedName = billing_resolve_checkout_product_name();

	const products = await billing.listProducts(ctx);
	const activeMatches = products.filter((product) => product.name === expectedName && !product.isArchived);
	if (activeMatches.length > 1) {
		return { setup: "duplicate_product_name", expectedProductName: expectedName };
	}
	const product = activeMatches[0];
	if (!product) {
		return { setup: "product_not_in_catalog", expectedProductName: expectedName };
	}
	return { setup: "ready", payAsYouGo: product };
}

/**
 * Catalog + checkout setup state for the pay-as-you-go plan.
 */
export const get_pay_as_you_go_product = internalQuery({
	args: {},
	handler: async (ctx): Promise<BillingPayAsYouGoQueryResult> => {
		const base = await billing_try_resolve_pay_as_you_go_product(ctx);
		if (base.setup === "ready") {
			return { setup: "ready", payAsYouGo: base.payAsYouGo };
		}
		if (base.setup === "product_not_in_catalog") {
			return {
				setup: "product_not_in_catalog",
				expectedProductName: base.expectedProductName,
			};
		}
		return {
			setup: "duplicate_product_name",
			expectedProductName: base.expectedProductName,
		};
	},
});

type BillingPolarBenefit = NonNullable<BillingPayAsYouGoProductRow["benefits"]>[number];

function billing_try_parse_meter_credit_included_units(
	benefits: BillingPayAsYouGoProductRow["benefits"],
): number | null {
	if (!benefits) {
		return null;
	}
	for (const benefit of benefits) {
		if (benefit.type !== "meter_credit") {
			continue;
		}
		const props = benefit.properties;
		if (props == null) {
			continue;
		}
		if (typeof props === "number" && Number.isFinite(props)) {
			return props;
		}
		if (typeof props === "object" && !Array.isArray(props)) {
			const record = props as Record<string, unknown>;
			for (const key of ["amount", "credits", "quantity", "units", "meterCreditAmount"] as const) {
				const value = record[key];
				if (typeof value === "number" && Number.isFinite(value)) {
					return value;
				}
				if (typeof value === "string" && value.trim() !== "") {
					const parsed = Number(value);
					if (!Number.isNaN(parsed)) {
						return parsed;
					}
				}
			}
		}
	}
	return null;
}

type BillingPaygSubscriptionSelection =
	| { kind: "none" }
	| { kind: "ambiguous"; count: number }
	| {
			kind: "single";
			subscription: Awaited<ReturnType<typeof billing.listAllUserSubscriptions>>[number];
	  };

function billing_select_payg_subscription(
	subs: Awaited<ReturnType<typeof billing.listAllUserSubscriptions>>,
	paygProductId: string,
): BillingPaygSubscriptionSelection {
	const matching = subs.filter((s) => s.productId === paygProductId);
	const activeLike = matching.filter((s) => (s.status === "active" || s.status === "trialing") && !s.endedAt);
	if (activeLike.length === 0) {
		return { kind: "none" };
	}
	if (activeLike.length > 1) {
		return { kind: "ambiguous", count: activeLike.length };
	}
	return { kind: "single", subscription: activeLike[0]! };
}

export type BillingPlanDetails = {
	productId: string;
	productName: string;
	description: string | null;
	benefitDescriptions: string[];
	recurringInterval: string | null;
	priceCurrency: string | null;
	isMetered: boolean;
	unitAmount: number | null;
	meterName: string | null;
	meterId: string | null;
	includedMeterCreditsUnits: number | null;
	hasMeterCreditBenefit: boolean;
};

function billing_payg_meter_id_and_name_from_product(product: BillingPayAsYouGoProductRow): {
	meterId: string | null;
	meterName: string | null;
} {
	const primaryPrice = product.prices?.find((priceRow) => !priceRow.isArchived) ?? product.prices?.[0];
	return {
		meterId: primaryPrice?.meterId ?? primaryPrice?.meter?.id ?? null,
		meterName: primaryPrice?.meter?.name ?? null,
	};
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
	| "lastError"
>;

type BillingUsageSyncFailurePublic = Pick<Doc<"billing_usage_sync_failures">, "message" | "at">;

function billing_usage_overview_from_snapshot(
	snap: Doc<"billing_usage_snapshots">,
	state: "ready" | "stale",
): { state: "ready" | "stale" } & BillingUsageOverviewSnapshotFields {
	return {
		state,
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
		lastError: snap.lastError,
	};
}

/**
 * Map Polar {@link CustomerState} to a snapshot row for the curated pay-as-you-go product.
 * Return `null` when the customer has zero, multiple, or unmetered PAYG subscriptions in Polar state.
 */
export function billing_usage_snapshot_fields_from_customer_state(args: {
	customerState: CustomerState;
	paygProductId: string;
	preferredMeterId: string | null;
	preferredMeterName: string | null;
	userId: string;
	polarCustomerId: string;
	now: number;
	reason?: string;
}): BillingSnapshotWrite | null {
	const { customerState, paygProductId, preferredMeterId, preferredMeterName, userId, polarCustomerId, now, reason } =
		args;
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
		lastRefreshReason: reason,
	};
}

function billing_plan_details_from_product(product: BillingPayAsYouGoProductRow): BillingPlanDetails {
	const primaryPrice = product.prices?.find((priceRow) => !priceRow.isArchived) ?? product.prices?.[0];
	const raw = primaryPrice?.unitAmount;
	const unitAmount = raw === undefined || raw === null ? null : typeof raw === "number" ? raw : Number(raw);
	return {
		productId: product.id,
		productName: product.name,
		description: product.description?.trim() || null,
		benefitDescriptions: (product.benefits ?? [])
			.map((benefit) => benefit.description.trim())
			.filter((description) => description.length > 0),
		recurringInterval: primaryPrice?.recurringInterval ?? product.recurringInterval ?? null,
		priceCurrency: primaryPrice?.priceCurrency ?? null,
		isMetered: primaryPrice?.amountType === "metered_unit",
		unitAmount,
		meterName: primaryPrice?.meter?.name ?? null,
		meterId: primaryPrice?.meterId ?? primaryPrice?.meter?.id ?? null,
		includedMeterCreditsUnits: billing_try_parse_meter_credit_included_units(product.benefits),
		hasMeterCreditBenefit: Boolean(product.benefits?.some((b: BillingPolarBenefit) => b.type === "meter_credit")),
	};
}

export type BillingUsageOverview =
	| { state: "unavailable" }
	| { state: "loading" }
	| ({ state: "error" } & BillingUsageSyncFailurePublic)
	| ({ state: "ready" | "stale" } & BillingUsageOverviewSnapshotFields);

type BillingSignedInOverviewBase = {
	access: "signed_in";
	usage: BillingUsageOverview;
	subscription:
		| { state: "none" }
		| { state: "ambiguous" }
		| {
				state: "active" | "trialing" | "cancel_at_period_end";
				polarStatus: string;
				cancelAtPeriodEnd: boolean;
				startedAt: string | null;
				currentPeriodStart: string;
				currentPeriodEnd: string | null;
				productName: string;
		  };
	showCheckout: boolean;
};

export type BillingSignedInOverview =
	| (BillingSignedInOverviewBase & {
			catalog: Exclude<BillingPayAsYouGoQueryResult, { setup: "ready" }>;
			planDetails: null;
	  })
	| (BillingSignedInOverviewBase & {
			catalog: Extract<BillingPayAsYouGoQueryResult, { setup: "ready" }>;
			planDetails: BillingPlanDetails;
	  });

export type BillingOverviewResult = { access: "anonymous" } | BillingSignedInOverview;

export const get_billing_overview = query({
	args: {},
	handler: async (ctx): Promise<BillingOverviewResult> => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!user || user.kind !== "signed_in") {
			return { access: "anonymous" };
		}
		const externalUserId = user.id;

		const catalogBase = await billing_try_resolve_pay_as_you_go_product(ctx);
		let catalog: BillingPayAsYouGoQueryResult;
		if (catalogBase.setup === "ready") {
			catalog = { setup: "ready", payAsYouGo: catalogBase.payAsYouGo };
		} else if (catalogBase.setup === "product_not_in_catalog") {
			catalog = {
				setup: "product_not_in_catalog",
				expectedProductName: catalogBase.expectedProductName,
			};
		} else {
			catalog = {
				setup: "duplicate_product_name",
				expectedProductName: catalogBase.expectedProductName,
			};
		}

		if (catalog.setup !== "ready") {
			return {
				access: "signed_in",
				catalog,
				planDetails: null,
				usage: { state: "unavailable" },
				subscription: { state: "none" },
				showCheckout: false,
			};
		}

		const planDetails = billing_plan_details_from_product(catalog.payAsYouGo);
		const paygId = catalog.payAsYouGo.id;
		const subs = await billing.listAllUserSubscriptions(ctx, { userId: externalUserId });
		const selection = billing_select_payg_subscription(subs, paygId);

		let subscription: BillingSignedInOverview["subscription"];
		let showCheckout = true;

		if (selection.kind === "ambiguous") {
			subscription = { state: "ambiguous" };
			showCheckout = false;
		} else if (selection.kind === "none") {
			subscription = { state: "none" };
			showCheckout = true;
		} else {
			const sub = selection.subscription;
			const productName = sub.product?.name ?? sub.productId;
			let state: "active" | "trialing" | "cancel_at_period_end";
			if (sub.status === "trialing") {
				state = "trialing";
			} else if (sub.cancelAtPeriodEnd) {
				state = "cancel_at_period_end";
			} else {
				state = "active";
			}
			subscription = {
				state,
				polarStatus: sub.status,
				cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
				startedAt: sub.startedAt ?? null,
				currentPeriodStart: sub.currentPeriodStart,
				currentPeriodEnd: sub.currentPeriodEnd ?? null,
				productName,
			};
			showCheckout = false;
		}

		const usage: BillingUsageOverview = await (async () => {
			if (!planDetails.isMetered) {
				return { state: "unavailable" };
			}
			if (subscription.state === "none" || subscription.state === "ambiguous") {
				return { state: "unavailable" };
			}
			const snap = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_userId", (q) => q.eq("userId", externalUserId))
				.unique();
			if (!snap) {
				const failure = await ctx.db
					.query("billing_usage_sync_failures")
					.withIndex("by_userId", (q) => q.eq("userId", externalUserId))
					.unique();
				if (failure) {
					return { state: "error", message: failure.message, at: failure.at };
				}
				return { state: "loading" };
			}
			const isStale = Date.now() - snap.lastSyncedAt > BILLING_USAGE_SNAPSHOT_STALE_AFTER_MS;
			return billing_usage_overview_from_snapshot(snap, isStale ? "stale" : "ready");
		})();

		return {
			access: "signed_in",
			catalog,
			planDetails,
			usage,
			subscription,
			showCheckout,
		};
	},
});

const billing_usage_snapshot_row_validator = v.object({
	userId: v.string(),
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
	lastRefreshReason: v.optional(v.string()),
});

export const upsert_usage_snapshot = internalMutation({
	args: {
		row: billing_usage_snapshot_row_validator,
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
		const failure = await ctx.db
			.query("billing_usage_sync_failures")
			.withIndex("by_userId", (q) => q.eq("userId", args.row.userId))
			.unique();
		if (failure) {
			await ctx.db.delete("billing_usage_sync_failures", failure._id);
		}
	},
});

export const clear_usage_snapshot = internalMutation({
	args: {
		userId: v.string(),
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

export const clear_usage_sync_failure = internalMutation({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		const failure = await ctx.db
			.query("billing_usage_sync_failures")
			.withIndex("by_userId", (q) => q.eq("userId", args.userId))
			.unique();
		if (failure) {
			await ctx.db.delete("billing_usage_sync_failures", failure._id);
		}
	},
});

export const record_usage_snapshot_refresh_error = internalMutation({
	args: {
		userId: v.string(),
		message: v.string(),
		at: v.number(),
	},
	handler: async (ctx, args) => {
		const truncated = args.message.length > 500 ? `${args.message.slice(0, 500)}…` : args.message;
		const existing = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_userId", (q) => q.eq("userId", args.userId))
			.unique();
		if (existing) {
			await ctx.db.patch("billing_usage_snapshots", existing._id, {
				lastError: truncated,
			});
			const failure = await ctx.db
				.query("billing_usage_sync_failures")
				.withIndex("by_userId", (q) => q.eq("userId", args.userId))
				.unique();
			if (failure) {
				await ctx.db.delete("billing_usage_sync_failures", failure._id);
			}
			return;
		}
		const priorFailure = await ctx.db
			.query("billing_usage_sync_failures")
			.withIndex("by_userId", (q) => q.eq("userId", args.userId))
			.unique();
		if (priorFailure) {
			await ctx.db.patch("billing_usage_sync_failures", priorFailure._id, {
				message: truncated,
				at: args.at,
			});
			return;
		}
		await ctx.db.insert("billing_usage_sync_failures", {
			userId: args.userId,
			message: truncated,
			at: args.at,
		});
	},
});

export const list_stale_usage_snapshots = internalQuery({
	args: {
		staleBefore: v.number(),
		limit: v.number(),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_lastSyncedAt", (q) => q.lt("lastSyncedAt", args.staleBefore))
			.take(args.limit);
	},
});

export const list_usage_sync_failures_ready_for_retry = internalQuery({
	args: {
		retryIfRecordedBefore: v.number(),
		limit: v.number(),
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("billing_usage_sync_failures")
			.withIndex("by_at", (q) => q.lte("at", args.retryIfRecordedBefore))
			.take(args.limit);
		return rows;
	},
});

export const refresh_usage_snapshot = internalAction({
	args: {
		userId: v.string(),
		reason: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const catalog = await ctx.runQuery(internal.billing.get_pay_as_you_go_product, {});
		if (catalog.setup !== "ready") {
			await ctx.runMutation(internal.billing.clear_usage_sync_failure, { userId: args.userId });
			return;
		}
		const paygId = catalog.payAsYouGo.id;
		const { meterId: catalogMeterId, meterName: catalogMeterName } = billing_payg_meter_id_and_name_from_product(
			catalog.payAsYouGo,
		);

		const subs = await ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
			userId: args.userId,
		});
		const selection = billing_select_payg_subscription(subs, paygId);
		if (selection.kind === "ambiguous") {
			await ctx.runMutation(internal.billing.clear_usage_snapshot, { userId: args.userId });
			await ctx.runMutation(internal.billing.record_usage_snapshot_refresh_error, {
				userId: args.userId,
				message: "Multiple active pay-as-you-go subscriptions. Resolve duplicates in Polar, then open Billing again.",
				at: now,
			});
			return;
		}

		let customerState: CustomerState;
		try {
			const state = await billing_get_customer_state(ctx, args.userId);
			if (!state) {
				await ctx.runMutation(internal.billing.clear_usage_snapshot, { userId: args.userId });
				await ctx.runMutation(internal.billing.clear_usage_sync_failure, { userId: args.userId });
				return;
			}
			customerState = state;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[billing.refresh_usage_snapshot] Polar customer state failed", {
				userId: args.userId,
				reason: args.reason,
				error: message,
			});
			await ctx.runMutation(internal.billing.record_usage_snapshot_refresh_error, {
				userId: args.userId,
				message,
				at: now,
			});
			return;
		}

		const fields = billing_usage_snapshot_fields_from_customer_state({
			customerState,
			paygProductId: paygId,
			preferredMeterId: catalogMeterId,
			preferredMeterName: catalogMeterName,
			userId: args.userId,
			polarCustomerId: customerState.id,
			now,
			reason: args.reason,
		});
		if (!fields) {
			await ctx.runMutation(internal.billing.clear_usage_snapshot, { userId: args.userId });
			await ctx.runMutation(internal.billing.clear_usage_sync_failure, { userId: args.userId });
			return;
		}
		await ctx.runMutation(internal.billing.upsert_usage_snapshot, { row: fields });
	},
});

export const reconcile_stale_billing_usage_snapshots = internalAction({
	args: {},
	handler: async (ctx) => {
		const staleBefore = Date.now() - BILLING_USAGE_SNAPSHOT_STALE_AFTER_MS;
		const rows = await ctx.runQuery(internal.billing.list_stale_usage_snapshots, {
			staleBefore,
			limit: 32,
		});
		for (const row of rows) {
			await ctx.scheduler.runAfter(0, internal.billing.refresh_usage_snapshot, {
				userId: row.userId,
				reason: "reconcile_stale_snapshot",
			});
		}
		const failures = await ctx.runQuery(internal.billing.list_usage_sync_failures_ready_for_retry, {
			retryIfRecordedBefore: Date.now() - 30_000,
			limit: 16,
		});
		for (const row of failures) {
			await ctx.scheduler.runAfter(0, internal.billing.refresh_usage_snapshot, {
				userId: row.userId,
				reason: "reconcile_sync_failure",
			});
		}
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
 * Server-curated checkout: only the pay-as-you-go product synced under {@link PRODUCTS.PAY_AS_YOU_GO} may
 * be purchased. {@link origin} and {@link successUrl} are checked against {@link ALLOWED_ORIGINS}.
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
		if (catalog.setup !== "ready") {
			throw new ConvexError("Checkout is not available for this deployment");
		}

		const curatedId = catalog.payAsYouGo.id;
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

export const generateCustomerPortalUrl = billing_api.generateCustomerPortalUrl;

export const changeCurrentSubscription = action({
	args: {
		productId: v.string(),
	},
	handler: async () => {
		throw new Error("Plan changes are not supported");
	},
});

export const cancelCurrentSubscription = billing_api.cancelCurrentSubscription;
export const listAllSubscriptions = billing_api.listAllSubscriptions;

export const list_all_products = internalQuery({
	args: {},
	handler: async (ctx) => {
		return await billing.listProducts(ctx);
	},
});

/** Run from repo: `pnpm exec convex run internal.billing.sync_products` (cwd: packages/app). */
export const sync_products = internalAction({
	args: {},
	handler: async (ctx) => {
		await billing.syncProducts(ctx);
	},
});

export async function billing_enqueue_page_save_event(
	ctx: MutationCtx,
	args: {
		userId: string;
		pageId: Id<"pages">;
		workspaceId: string;
		projectId: string;
		newSequence: number;
		now: number;
	},
) {
	const eventName = BILLING_EVENTS.testUnit;
	const dedupeKey = `${eventName}:${args.userId}:${args.pageId}:${args.newSequence}`;
	const existing = await ctx.db
		.query("polar_usage_events_outbox")
		.withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", dedupeKey))
		.first();
	if (existing) {
		return;
	}

	await ctx.db.insert("polar_usage_events_outbox", {
		dedupeKey,
		externalCustomerId: args.userId,
		eventName,
		status: "pending",
		createdAt: args.now,
		metadata: {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			pageId: args.pageId,
			yjsSequence: String(args.newSequence),
			source: "page-save",
		},
	});
}

export const list_pending_outbox_rows = internalQuery({
	args: {
		limit: v.number(),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("polar_usage_events_outbox")
			.withIndex("by_status_createdAt", (q) => q.eq("status", "pending"))
			.order("asc")
			.take(args.limit);
	},
});

export const delete_outbox_row = internalMutation({
	args: {
		id: v.id("polar_usage_events_outbox"),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get("polar_usage_events_outbox", args.id);
		if (!row) return;
		await ctx.db.delete("polar_usage_events_outbox", row._id);
	},
});

export const fail_outbox_row = internalMutation({
	args: {
		id: v.id("polar_usage_events_outbox"),
		message: v.string(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get("polar_usage_events_outbox", args.id);
		if (!row) {
			return;
		}
		const truncated = args.message.length > 500 ? `${args.message.slice(0, 500)}…` : args.message;
		await ctx.db.patch("polar_usage_events_outbox", args.id, {
			status: "failed",
			lastError: truncated,
		});
	},
});

export const drain_outbox = internalAction({
	args: {},
	handler: async (ctx) => {
		const client = new PolarCore({
			accessToken: POLAR_ORGANIZATION_TOKEN,
			server: POLAR_SERVER,
		});

		const rows = await ctx.runQuery(internal.billing.list_pending_outbox_rows, {
			limit: BILLING_OUTBOX_MAX_DRAIN_PER_RUN,
		});

		const userIdsToRefresh = new Set<string>();

		for (const row of rows) {
			try {
				const metadataRecord = row.metadata ?? {};
				const userId = row.externalCustomerId;
				const mapped = await ctx.runQuery(components.polar.lib.getCustomerByUserId, {
					userId,
				});
				// Prefer Polar `customerId` when the component has a customer mapping so ingest targets the same customer
				// row `getCustomerState` uses for snapshots.
				const event = mapped
					? {
							name: row.eventName,
							customerId: mapped.id,
							externalId: row.dedupeKey,
							metadata: metadataRecord,
						}
					: {
							name: row.eventName,
							externalCustomerId: userId,
							externalId: row.dedupeKey,
							metadata: metadataRecord,
						};
				const ingestResult = await eventsIngest(client, {
					events: [event],
				});

				if (ingestResult.ok) {
					await ctx.runMutation(internal.billing.delete_outbox_row, {
						id: row._id,
					});
					userIdsToRefresh.add(userId);
					continue;
				}

				const message = JSON.stringify(ingestResult.error);
				console.error("[billing.drain_outbox] failed to ingest billing event", {
					id: row._id,
					dedupeKey: row.dedupeKey,
					eventName: row.eventName,
					externalCustomerId: row.externalCustomerId,
					ingestError: message,
				});
				await ctx.runMutation(internal.billing.fail_outbox_row, {
					id: row._id,
					message,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error("[billing.drain_outbox] failed to ingest billing event", {
					id: row._id,
					dedupeKey: row.dedupeKey,
					eventName: row.eventName,
					externalCustomerId: row.externalCustomerId,
					error: message,
				});
				await ctx.runMutation(internal.billing.fail_outbox_row, {
					id: row._id,
					message,
				});
			}
		}

		// Run refresh inline so each outbox drain finishes the snapshot update in the same action.
		// (Convex HTTP routes use `scheduler` because they run in HTTP actions; cron reconciliation
		// also schedules. `convex-test` does not reliably drain `runAfter(0)` before the test ends.)
		for (const userId of userIdsToRefresh) {
			await ctx.runAction(internal.billing.refresh_usage_snapshot, {
				userId,
				reason: "usage_event_ingested",
			});
		}
	},
});
