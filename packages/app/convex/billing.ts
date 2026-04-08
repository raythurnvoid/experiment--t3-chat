import { Polar } from "@convex-dev/polar";
import { PolarCore } from "@polar-sh/sdk/core.js";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	query,
} from "./_generated/server.js";
import { PRODUCTS } from "../shared/billing_catalog.js";
import { BILLING_EVENTS } from "../shared/billing_events.js";

if (!process.env.VITE_CONVEX_HTTP_URL) {
	throw new Error("VITE_CONVEX_HTTP_URL is not set in Convex env");
}

const ANONYMOUS_USERS_JWT_ISSUER = process.env.VITE_CONVEX_HTTP_URL;

const billing_outbox_max_drain_per_run = 24;

export { BILLING_EVENTS, PRODUCTS };

/**
 * Single Polar client for this app: register webhook routes on this instance only, and use
 * {@link billing.api} exports for Convex functions (see @convex-dev/polar README).
 */
export const billing = new Polar<DataModel>(components.polar, {
	getUserInfo: async (ctx) => {
		return await billing_get_user_info_from_auth(ctx as QueryCtx | ActionCtx);
	},
	server: billing_server_mode(),
});

const billing_api = billing.api();

function billing_resolve_checkout_product_name() {
	const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim();
	if (!prefix) {
		return null;
	}
	return `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;
}

function billing_server_mode() {
	const raw = process.env.POLAR_SERVER?.trim();
	if (raw === undefined || raw === "") {
		return "sandbox";
	}
	if (raw === "sandbox" || raw === "production") {
		return raw;
	}
	throw new Error(`POLAR_SERVER must be "sandbox" or "production" when set, got: ${raw}`);
}

async function billing_get_user_info_from_auth(ctx: QueryCtx | ActionCtx) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error("Unauthorized");
	}
	if (identity.issuer === ANONYMOUS_USERS_JWT_ISSUER) {
		throw new Error("Billing requires a signed-in account");
	}
	if (!identity.external_id) {
		throw new Error("Unauthorized");
	}
	const email = identity.email?.trim();
	if (!email) {
		throw new Error("Email required for billing");
	}

	return { userId: identity.external_id, email };
}

function billing_collect_config_warnings() {
	const warnings: string[] = [];
	if (!process.env.POLAR_SERVER?.trim()) {
		warnings.push("POLAR_SERVER is unset; Polar API calls use the sandbox environment.");
	}
	return warnings;
}

type BillingPayAsYouGoProductRow = NonNullable<Awaited<ReturnType<typeof billing.listProducts>>[number]>;

type BillingPayAsYouGoQueryResult =
	| {
			setup: "ready";
			payAsYouGo: BillingPayAsYouGoProductRow;
			warnings: string[];
	  }
	| {
			setup: "missing_prefix";
			warnings: string[];
	  }
	| {
			setup: "product_not_in_catalog";
			expectedProductName: string;
			warnings: string[];
	  }
	| {
			setup: "duplicate_product_name";
			expectedProductName: string;
			warnings: string[];
	  };

type BillingPayAsYouGoResolution =
	| { setup: "ready"; payAsYouGo: BillingPayAsYouGoProductRow }
	| { setup: "missing_prefix" }
	| { setup: "product_not_in_catalog"; expectedProductName: string }
	| { setup: "duplicate_product_name"; expectedProductName: string };

async function billing_try_resolve_pay_as_you_go_product(
	ctx: QueryCtx | ActionCtx,
): Promise<BillingPayAsYouGoResolution> {
	const expectedName = billing_resolve_checkout_product_name();
	if (!expectedName) {
		return { setup: "missing_prefix" };
	}

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
 * Catalog + checkout setup state for the pay-as-you-go plan (and operator warnings).
 */
export const get_pay_as_you_go_product = internalQuery({
	args: {},
	handler: async (ctx): Promise<BillingPayAsYouGoQueryResult> => {
		const warnings = billing_collect_config_warnings();
		const base = await billing_try_resolve_pay_as_you_go_product(ctx);
		if (base.setup === "ready") {
			return { setup: "ready", payAsYouGo: base.payAsYouGo, warnings };
		}
		if (base.setup === "missing_prefix") {
			return { setup: "missing_prefix", warnings };
		}
		if (base.setup === "product_not_in_catalog") {
			return {
				setup: "product_not_in_catalog",
				expectedProductName: base.expectedProductName,
				warnings,
			};
		}
		return {
			setup: "duplicate_product_name",
			expectedProductName: base.expectedProductName,
			warnings,
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
	const activeLike = matching.filter(
		(s) => (s.status === "active" || s.status === "trialing") && !s.endedAt,
	);
	if (activeLike.length === 0) {
		return { kind: "none" };
	}
	if (activeLike.length > 1) {
		return { kind: "ambiguous", count: activeLike.length };
	}
	return { kind: "single", subscription: activeLike[0]! };
}

type BillingPlanDetails = {
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

function billing_plan_details_from_product(product: BillingPayAsYouGoProductRow): BillingPlanDetails {
	const primaryPrice =
		product.prices?.find((priceRow) => !priceRow.isArchived) ?? product.prices?.[0];
	const raw = primaryPrice?.unitAmount;
	const unitAmountParsed =
		typeof raw === "string"
			? Number(raw)
			: typeof raw === "number"
				? raw
				: null;
	const unitAmount =
		unitAmountParsed != null && Number.isFinite(unitAmountParsed) ? unitAmountParsed : null;
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
		hasMeterCreditBenefit: Boolean(
			product.benefits?.some((b: BillingPolarBenefit) => b.type === "meter_credit"),
		),
	};
}

export type BillingSignedInOverview = {
	access: "signed_in";
	catalog: BillingPayAsYouGoQueryResult;
	planDetails: BillingPlanDetails | null;
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
	warnings: string[];
};

export type BillingOverviewResult = { access: "anonymous" } | BillingSignedInOverview;

export const get_billing_overview = query({
	args: {},
	handler: async (ctx): Promise<BillingOverviewResult> => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) {
			return { access: "anonymous" };
		}
		if (identity.issuer === ANONYMOUS_USERS_JWT_ISSUER) {
			return { access: "anonymous" };
		}
		const externalUserId = identity.external_id?.trim();
		if (!externalUserId) {
			return { access: "anonymous" };
		}

		const warnings = billing_collect_config_warnings();
		const catalogBase = await billing_try_resolve_pay_as_you_go_product(ctx);
		let catalog: BillingPayAsYouGoQueryResult;
		if (catalogBase.setup === "ready") {
			catalog = { setup: "ready", payAsYouGo: catalogBase.payAsYouGo, warnings };
		} else if (catalogBase.setup === "missing_prefix") {
			catalog = { setup: "missing_prefix", warnings };
		} else if (catalogBase.setup === "product_not_in_catalog") {
			catalog = {
				setup: "product_not_in_catalog",
				expectedProductName: catalogBase.expectedProductName,
				warnings,
			};
		} else {
			catalog = {
				setup: "duplicate_product_name",
				expectedProductName: catalogBase.expectedProductName,
				warnings,
			};
		}

		const planDetails =
			catalog.setup === "ready" ? billing_plan_details_from_product(catalog.payAsYouGo) : null;

		if (catalog.setup !== "ready") {
			return {
				access: "signed_in",
				catalog,
				planDetails,
				subscription: { state: "none" },
				showCheckout: false,
				warnings,
			};
		}

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

		return {
			access: "signed_in",
			catalog,
			planDetails,
			subscription,
			showCheckout,
			warnings,
		};
	},
});

type BillingAllowedOriginsParse =
	| { kind: "unset" }
	| { kind: "configured"; origins: string[] }
	| { kind: "misconfigured" };

function billing_parse_allowed_origins_from_env(): BillingAllowedOriginsParse {
	const raw = process.env.ALLOWED_ORIGINS?.trim();
	if (!raw) {
		return { kind: "unset" };
	}
	const origins: string[] = [];
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		try {
			origins.push(new URL(trimmed).origin);
		} catch {
			// Skip invalid URL tokens; empty after parse is misconfiguration when raw was non-empty.
		}
	}
	if (origins.length === 0) {
		return { kind: "misconfigured" };
	}
	return { kind: "configured", origins };
}

function billing_checkout_callback_urls_allowed(origin: string, successUrl: string) {
	const parsed = billing_parse_allowed_origins_from_env();
	if (parsed.kind === "misconfigured") {
		throw new Error("ALLOWED_ORIGINS is misconfigured");
	}
	if (parsed.kind === "unset") {
		return;
	}
	const allowedOrigins = parsed.origins;

	let originParsed: URL;
	let successParsed: URL;
	try {
		originParsed = new URL(origin);
		successParsed = new URL(successUrl);
	} catch {
		throw new Error("Invalid checkout URL");
	}

	if (!allowedOrigins.includes(originParsed.origin)) {
		throw new Error("Origin is not allowed for checkout");
	}

	const successOk = allowedOrigins.some(
		(allowedOrigin) =>
			successParsed.origin === allowedOrigin ||
			successParsed.href.startsWith(`${allowedOrigin}/`),
	);
	if (!successOk) {
		throw new Error("Success URL is not allowed for checkout");
	}
}

/**
 * Server-curated checkout: only the pay-as-you-go product synced under {@link PRODUCTS.PAY_AS_YOU_GO} may
 * be purchased. {@link origin} and {@link successUrl} must match {@link process.env.ALLOWED_ORIGINS} when
 * it parses to at least one valid URL origin; a non-empty but invalid list is treated as misconfiguration.
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

		const { userId, email } = await billing_get_user_info_from_auth(ctx);

		const catalog = await ctx.runQuery(internal.billing.get_pay_as_you_go_product, {});
		if (catalog.setup !== "ready") {
			throw new Error("Checkout is not available for this deployment");
		}

		const curatedId = catalog.payAsYouGo.id;
		if (args.productIds.length !== 1 || args.productIds[0] !== curatedId) {
			throw new Error("Invalid checkout product");
		}
		const { url: baseUrl } = await billing.createCheckoutSession(ctx, {
			productIds: [curatedId],
			userId,
			email,
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
	if (!process.env.POLAR_ORGANIZATION_TOKEN?.trim()) {
		return;
	}

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
		const truncated =
			args.message.length > 500 ? `${args.message.slice(0, 500)}…` : args.message;
		await ctx.db.patch("polar_usage_events_outbox", args.id, {
			status: "failed",
			lastError: truncated,
		});
	},
});

export const drain_outbox = internalAction({
	args: {},
	handler: async (ctx) => {
		const token = process.env.POLAR_ORGANIZATION_TOKEN?.trim();
		if (!token) {
			console.warn("[billing.drain_outbox] POLAR_ORGANIZATION_TOKEN not set; skip");
			return;
		}

		const client = new PolarCore({
			accessToken: token,
			server: billing_server_mode(),
		});

		const rows = await ctx.runQuery(internal.billing.list_pending_outbox_rows, {
			limit: billing_outbox_max_drain_per_run,
		});

		for (const row of rows) {
			try {
				const metadataRecord = row.metadata ?? {};
				// Keep `externalId` aligned with `dedupeKey`: this optimistic path relies on Polar-side dedupe
				// if the same row is drained more than once before future workflow orchestration exists.
				const ingestResult = await eventsIngest(client, {
					events: [
						{
							name: row.eventName,
							externalCustomerId: row.externalCustomerId,
							externalId: row.dedupeKey,
							metadata: metadataRecord,
						},
					],
				});

				if (ingestResult.ok) {
					await ctx.runMutation(internal.billing.delete_outbox_row, {
						id: row._id,
					});
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
	},
});
