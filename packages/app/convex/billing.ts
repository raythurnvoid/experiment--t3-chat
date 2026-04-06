import { Polar } from "@convex-dev/polar";
import { PolarCore } from "@polar-sh/sdk/core.js";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { v } from "convex/values";
import { api, components, internal } from "./_generated/api.js";
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

if (!process.env.VITE_CONVEX_HTTP_URL) {
	throw new Error("VITE_CONVEX_HTTP_URL is not set in Convex env");
}

const ANONYMOUS_USERS_JWT_ISSUER = process.env.VITE_CONVEX_HTTP_URL;

const billing_outbox_max_drain_per_run = 24;

export { PRODUCTS };

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
	if (!process.env.POLAR_USAGE_EVENT_NAME?.trim()) {
		warnings.push(
			"POLAR_USAGE_EVENT_NAME is unset; meter events use the built-in default event name (not your production meter name).",
		);
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
export const getPayAsYouGoProduct = query({
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
export const generateCheckoutLink = action({
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

		const catalog = await ctx.runQuery(api.billing.getPayAsYouGoProduct, {});
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

const billing_usage_event_name_default = "billing-test-unit";

function billing_usage_event_name() {
	return process.env.POLAR_USAGE_EVENT_NAME?.trim() || billing_usage_event_name_default;
}

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

	const eventName = billing_usage_event_name();
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
	// Skip `runAfter` in Vitest: convex-test schedules via setTimeout and completing that job can error on `_scheduled_functions` writes while draining still works via `t.action`.
	if (process.env.POLAR_USAGE_DISABLE_SCHEDULED_DRAIN_IN_TESTS?.trim() === "1") {
		return;
	}
	await ctx.scheduler.runAfter(0, internal.billing.drain_outbox, {});
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
