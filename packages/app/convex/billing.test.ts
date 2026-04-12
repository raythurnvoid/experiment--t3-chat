import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { billing_EVENTS } from "../server/billing.ts";
import { api, components, internal } from "./_generated/api.js";
import { test_convex } from "./setup.test.ts";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import type { Id } from "./_generated/dataModel.js";

vi.mock("@polar-sh/sdk/core.js", () => ({
	PolarCore: class PolarCoreMock {
		constructor(_args: unknown) {}
	},
}));

vi.mock("@polar-sh/sdk/funcs/eventsIngest.js", () => ({
	eventsIngest: vi.fn(),
}));

const eventsIngestMock = vi.mocked(eventsIngest);

type BillingSeed = {
	polarProductId: string;
	polarProductName: string;
};

type BillingSeedBenefit = {
	id: string;
	createdAt: string;
	modifiedAt: string | null;
	type: string;
	description: string;
	selectable: boolean;
	deletable: boolean;
	organizationId: string;
	metadata?: Record<string, unknown>;
	properties?: unknown;
};

async function seed_pay_as_you_go_product(
	t: ReturnType<typeof test_convex>,
	args: {
		polarProductId: string;
		description?: string | null;
		benefits?: BillingSeedBenefit[];
	},
): Promise<BillingSeed> {
	const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim();
	if (!prefix) {
		throw new Error("Expected POLAR_PRODUCTS_PREFIX from setup-env.test.ts");
	}
	const polarProductName = `${prefix}-${billing_PRODUCTS["Pay As You Go"].name}`;
	await t.mutation(components.polar.lib.createProduct, {
		product: {
			id: args.polarProductId,
			organizationId: "billing_test_org",
			name: polarProductName,
			description: args.description ?? null,
			isRecurring: true,
			isArchived: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: null,
			recurringInterval: "month",
			metadata: {},
			prices: [
				{
					id: `${args.polarProductId}_price`,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					amountType: "metered_unit",
					isArchived: false,
					productId: args.polarProductId,
					priceCurrency: "usd",
					unitAmount: "5",
					recurringInterval: "month",
					meterId: "meter_units",
					meter: { id: "meter_units", name: "Billable units" },
				},
			],
			medias: [],
			benefits: args.benefits ?? [],
		},
	});
	return { polarProductId: args.polarProductId, polarProductName };
}

async function seed_pro_product(
	t: ReturnType<typeof test_convex>,
	args: {
		polarProductId: string;
		description?: string | null;
		benefits?: BillingSeedBenefit[];
	},
): Promise<BillingSeed> {
	const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim();
	if (!prefix) {
		throw new Error("Expected POLAR_PRODUCTS_PREFIX from setup-env.test.ts");
	}
	const polarProductName = `${prefix}-${billing_PRODUCTS.Pro.name}`;
	await t.mutation(components.polar.lib.createProduct, {
		product: {
			id: args.polarProductId,
			organizationId: "billing_test_org",
			name: polarProductName,
			description: args.description ?? null,
			isRecurring: true,
			isArchived: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: null,
			recurringInterval: "month",
			metadata: {},
			prices: [
				{
					id: `${args.polarProductId}_fixed_price`,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					amountType: "fixed",
					isArchived: false,
					productId: args.polarProductId,
					priceCurrency: "eur",
					priceAmount: 4000,
					recurringInterval: "month",
				},
				{
					id: `${args.polarProductId}_metered_price`,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					amountType: "metered_unit",
					isArchived: false,
					productId: args.polarProductId,
					priceCurrency: "eur",
					unitAmount: "1",
					recurringInterval: "month",
					meterId: "meter_press_usage",
					meter: { id: "meter_press_usage", name: "Press app usage" },
				},
			],
			medias: [],
			benefits: args.benefits ?? [
				{
					id: "benefit_pro_meter_credit",
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					type: "meter_credit",
					description: billing_PRODUCTS.Pro.benefits["Pro Included Usage"].description,
					selectable: false,
					deletable: false,
					organizationId: "billing_test_org",
					properties: { units: 5000 },
				},
			],
		},
	});
	return { polarProductId: args.polarProductId, polarProductName };
}

describe("billing list_products", () => {
	test("returns empty array when unauthenticated", async () => {
		const t = test_convex();

		const products = await t.query(api.billing.list_products, {});

		expect(products).toEqual([]);
	});

	test("returns empty array for anonymous JWT users", async () => {
		const t = test_convex();
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: "user_billing_overview_anonymous" as Id<"users">,
			name: "Overview Anonymous",
		});

		const products = await asAnonymous.query(api.billing.list_products, {});

		expect(products).toEqual([]);
	});

	test("returns empty array when Clerk external_id is not set yet", async () => {
		const t = test_convex();
		const asSignedInWithoutExternalId = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-without-external-id",
			name: "Overview No External Id",
			email: "overview-no-external-id@test.local",
		});

		const products = await asSignedInWithoutExternalId.query(api.billing.list_products, {});

		expect(products).toEqual([]);
	});

	test("returns products when user has no Polar customer row", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_none",
			description: "A flexible plan for teams that want to pay only for what they use.",
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_none" as Id<"users">,
			name: "Overview None",
			email: "overview-none@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		expect(products.find((product) => product.id === polarProductId)?.description).toBe(
			"A flexible plan for teams that want to pay only for what they use.",
		);
		expect(products.find((product) => product.id === polarProductId)?.prices[0]?.unitAmount).toBe("5");
		expect(products.find((product) => product.id === polarProductId)?.prices[0]?.meter?.name).toBe("Billable units");
		expect(products.find((product) => product.id === polarProductId)?.benefits).toEqual([]);
	});

	test("returns both known products from the catalog", async () => {
		const t = test_convex();
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_overview_prod_pro",
		});
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_payg",
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_known_products" as Id<"users">,
			name: "Overview Known Products",
			email: "overview-known-products@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});

		expect(products.some((product) => product.id === polarProProductId)).toBe(true);
		expect(products.some((product) => product.id === polarPaygProductId)).toBe(true);
		expect(
			products
				.find((product) => product.id === polarProProductId)
				?.prices?.some((price) => {
					return price.amountType === "fixed" && price.priceAmount === 4000;
				}),
		).toBe(true);
		expect(
			products
				.find((product) => product.id === polarProProductId)
				?.benefits?.some((benefit) => {
					return benefit.description === billing_PRODUCTS.Pro.benefits["Pro Included Usage"].description;
				}),
		).toBe(true);
	});

	test("parses included meter credits from meter_credit benefit properties", async () => {
		const t = test_convex();
		await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_credits",
			benefits: [
				{
					id: "ben_mc_1",
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					type: "meter_credit",
					description: billing_PRODUCTS["Pay As You Go"].benefits["Free Usage"].description,
					selectable: false,
					deletable: false,
					organizationId: "billing_test_org",
					properties: { units: 250 },
				},
			],
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_credits" as Id<"users">,
			name: "Overview Credits",
			email: "overview-credits@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		const paygProduct = products.find((product) => product.id === "billing_overview_prod_credits");
		expect(paygProduct?.benefits?.find((benefit) => benefit.type === "meter_credit")?.properties).toEqual({
			units: 250,
		});
		expect(paygProduct?.benefits?.some((benefit) => benefit.type === "meter_credit")).toBe(true);
		expect(paygProduct?.benefits?.map((benefit) => benefit.description)).toContain(
			billing_PRODUCTS["Pay As You Go"].benefits["Free Usage"].description,
		);
	});

	test("returns products while the user has an active subscription", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_active",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_active",
			userId: "user_billing_overview_active",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_overview_active",
				customerId: "cust_overview_active",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
				recurringInterval: "month",
				status: "active",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_active" as Id<"users">,
			name: "Overview Active",
			email: "overview-active@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		expect(products.some((product) => product.id === polarProductId)).toBe(true);
	});

	test("returns products while the user has a cancel_at_period_end subscription", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_cancel",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_cancel",
			userId: "user_billing_overview_cancel",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_overview_cancel",
				customerId: "cust_overview_cancel",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
				recurringInterval: "month",
				status: "active",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: true,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_cancel" as Id<"users">,
			name: "Overview Cancel",
			email: "overview-cancel@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		expect(products.some((product) => product.id === polarProductId)).toBe(true);
	});

	test("returns products while the user has a trialing subscription", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_trial",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_trial",
			userId: "user_billing_overview_trial",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_overview_trial",
				customerId: "cust_overview_trial",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: null,
				currency: "usd",
				recurringInterval: "month",
				status: "trialing",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-01-08T00:00:00.000Z",
				cancelAtPeriodEnd: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_trial" as Id<"users">,
			name: "Overview Trial",
			email: "overview-trial@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		expect(products.some((product) => product.id === polarProductId)).toBe(true);
	});

	test("returns empty array when billing is misconfigured", async () => {
		const t = test_convex();

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_misconfigured" as Id<"users">,
			name: "Overview Misconfigured",
			email: "overview-misconfigured@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		expect(products).toEqual([]);
	});
});

describe("billing list_subscriptions", () => {
	test("returns empty array when unauthenticated", async () => {
		const t = test_convex();

		const subscriptions = await t.query(api.billing.list_subscriptions, {});

		expect(subscriptions).toEqual([]);
	});

	test("returns empty array when the user has no subscriptions", async () => {
		const t = test_convex();
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_subscription_empty" as Id<"users">,
			name: "Subscription Empty",
			email: "subscription-empty@test.local",
		});

		const subscriptions = await asUser.query(api.billing.list_subscriptions, {});

		expect(subscriptions).toEqual([]);
	});

	test("returns raw active subscription rows", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_subscription_prod_active",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_subscription_active",
			userId: "user_billing_subscription_active",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_subscription_active",
				customerId: "cust_subscription_active",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
				recurringInterval: "month",
				status: "active",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_subscription_active" as Id<"users">,
			name: "Subscription Active",
			email: "subscription-active@test.local",
		});

		const subscriptions = await asUser.query(api.billing.list_subscriptions, {});
		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]?.productId).toBe(polarProductId);
		expect(subscriptions[0]?.status).toBe("active");
		expect(subscriptions[0]?.startedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	test("returns raw cancel_at_period_end subscriptions", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_subscription_prod_cancel",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_subscription_cancel",
			userId: "user_billing_subscription_cancel",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_subscription_cancel",
				customerId: "cust_subscription_cancel",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
				recurringInterval: "month",
				status: "active",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: true,
				canceledAt: "2026-01-15T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:00.000Z",
				endsAt: "2026-02-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_subscription_cancel" as Id<"users">,
			name: "Subscription Cancel",
			email: "subscription-cancel@test.local",
		});

		const subscriptions = await asUser.query(api.billing.list_subscriptions, {});
		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]?.productId).toBe(polarProductId);
		expect(subscriptions[0]?.status).toBe("active");
		expect(subscriptions[0]?.cancelAtPeriodEnd).toBe(true);
		expect(subscriptions[0]?.canceledAt).toBe("2026-01-15T00:00:00.000Z");
		expect(subscriptions[0]?.endsAt).toBe("2026-02-01T00:00:00.000Z");
	});

	test("returns raw trialing subscriptions", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_subscription_prod_trial",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_subscription_trial",
			userId: "user_billing_subscription_trial",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_subscription_trial",
				customerId: "cust_subscription_trial",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: null,
				currency: "usd",
				recurringInterval: "month",
				status: "trialing",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-01-08T00:00:00.000Z",
				cancelAtPeriodEnd: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_subscription_trial" as Id<"users">,
			name: "Subscription Trial",
			email: "subscription-trial@test.local",
		});

		const subscriptions = await asUser.query(api.billing.list_subscriptions, {});
		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]?.productId).toBe(polarProductId);
		expect(subscriptions[0]?.status).toBe("trialing");
	});
});

describe("billing get_usage_snapshot", () => {
	test("returns null when unauthenticated", async () => {
		const t = test_convex();

		const usage = await t.query(api.billing.get_usage_snapshot, {});

		expect(usage).toBeNull();
	});

	test("returns null when no snapshot exists", async () => {
		const t = test_convex();
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_usage_empty" as Id<"users">,
			name: "Usage Empty",
			email: "usage-empty@test.local",
		});

		const usage = await asUser.query(api.billing.get_usage_snapshot, {});

		expect(usage).toBeNull();
	});

	test("returns snapshot fields when a billing_usage_snapshots row exists", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_usage_prod_ready",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_usage_ready",
			userId: "user_billing_usage_ready",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_usage_ready",
				customerId: "cust_usage_ready",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
				recurringInterval: "month",
				status: "active",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const syncedAt = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_snapshots", {
				userId: "user_billing_usage_ready" as Id<"users">,
				polarCustomerId: "cust_usage_ready",
				subscription: {
					id: "sub_usage_ready",
					productId: polarProductId,
					currency: "usd",
					currentPeriodStart: "2026-01-01T00:00:00.000Z",
					currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				},
				meter: {
					id: "meter_units",
					consumedUnits: 4,
					creditedUnits: 100,
					balance: 96,
					amountDueCents: 250,
				},
				lastSyncedAt: syncedAt,
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_usage_ready" as Id<"users">,
			name: "Usage Ready",
			email: "usage-ready@test.local",
		});

		const usage = await asUser.query(api.billing.get_usage_snapshot, {});
		expect(usage).not.toBeNull();
		if (!usage) {
			throw new Error("Expected usage snapshot");
		}
		expect(usage.subscription?.productId).toBe(polarProductId);
		expect(usage.meter?.consumedUnits).toBe(4);
		expect(usage.meter?.amountDueCents).toBe(250);
		expect(usage.meter?.balance).toBe(96);
		expect(usage.lastSyncedAt).toBe(syncedAt);
	});
});

describe("billing generate_checkout_link auth", () => {
	test("rejects anonymous identity before Polar SDK", async () => {
		const t = test_convex();
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: "user_anon_checkout",
			name: "Anon Checkout",
		});

		await expect(
			asAnonymous.action(api.billing.generate_checkout_link, {
				productIds: ["prod_x"],
				origin: "https://app.test",
				successUrl: "https://app.test/ok",
			}),
		).rejects.toThrow("Billing requires a signed-in account");
	});

	test("rejects Clerk identity without email before Polar SDK", async () => {
		const t = test_convex();
		const asUserNoEmail = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_no_email_checkout" as Id<"users">,
			name: "No Email",
		});

		await expect(
			asUserNoEmail.action(api.billing.generate_checkout_link, {
				productIds: ["prod_x"],
				origin: "https://app.test",
				successUrl: "https://app.test/ok",
			}),
		).rejects.toThrow("Email required for billing");
	});
});

describe("handle_polar_customer_state_update", () => {
	test("writes the usage snapshot directly from the first active subscription meter in the webhook payload", async () => {
		const t = test_convex();
		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim();
		if (!prefix) {
			throw new Error("Expected POLAR_PRODUCTS_PREFIX from setup-env.test.ts");
		}
		const polarProductId = "billing_refresh_snapshot_webhook_product";
		const polarProductName = `${prefix}-${billing_PRODUCTS["Pay As You Go"].name}`;

		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: polarProductId,
				organizationId: "billing_test_org",
				name: polarProductName,
				description: null,
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [
					{
						id: "price_old_webhook_meter",
						createdAt: "2025-12-01T00:00:00.000Z",
						modifiedAt: null,
						amountType: "metered_unit",
						isArchived: false,
						productId: polarProductId,
						priceCurrency: "eur",
						unitAmount: "1",
						recurringInterval: "month",
						meterId: "meter_old_webhook",
						meter: { id: "meter_old_webhook", name: "Legacy usage" },
					},
					{
						id: "price_new_webhook_meter",
						createdAt: "2026-01-01T00:00:00.000Z",
						modifiedAt: null,
						amountType: "metered_unit",
						isArchived: false,
						productId: polarProductId,
						priceCurrency: "eur",
						unitAmount: "1",
						recurringInterval: "month",
						meterId: "meter_new_webhook",
						meter: { id: "meter_new_webhook", name: "Press usage" },
					},
				],
				medias: [],
				benefits: [],
			},
		});

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-11T05:30:11.300891Z",
				data: {
					id: "cust_refresh_snapshot_webhook",
					created_at: "2026-04-07T12:47:35.912837Z",
					modified_at: "2026-04-11T04:53:38.614819Z",
					metadata: {
						userId: "user_refresh_snapshot_webhook",
					},
					external_id: "user_refresh_snapshot_webhook" as Id<"users">,
					email: "billing@example.com",
					email_verified: false,
					type: "individual",
					name: "Billing Test",
					billing_address: {
						line1: null,
						line2: null,
						postal_code: null,
						city: null,
						state: null,
						country: "PT",
					},
					tax_id: null,
					locale: "en-US",
					organization_id: "billing_test_org",
					deleted_at: null,
					active_subscriptions: [
						{
							id: "sub_refresh_snapshot_webhook",
							created_at: "2026-04-07T12:51:57.218982Z",
							modified_at: null,
							metadata: {},
							status: "active",
							amount: 0,
							product_id: polarProductId,
							price_id: "price_new_webhook_meter",
							currency: "eur",
							recurring_interval: "month",
							current_period_start: "2026-04-07T12:51:57.211492Z",
							current_period_end: "2026-05-07T12:51:57.211492Z",
							trial_start: null,
							trial_end: null,
							cancel_at_period_end: false,
							canceled_at: null,
							started_at: "2026-04-07T12:51:57.211492Z",
							ends_at: null,
							discount_id: null,
							custom_field_data: {},
							meters: [
								{
									id: "sub_meter_refresh_snapshot_webhook",
									created_at: "2026-04-07T12:47:51.954545Z",
									modified_at: "2026-04-09T03:59:32.439531Z",
									meter_id: "meter_new_webhook",
									consumed_units: 6,
									credited_units: 0,
									amount: 6,
								},
							],
						},
					],
					granted_benefits: [
						{
							id: "benefit_refresh_snapshot_webhook",
							created_at: "2026-04-07T12:51:58.518748Z",
							modified_at: "2026-04-07T12:51:58.603084Z",
							granted_at: "2026-04-07T12:51:58.602025Z",
							benefit_id: "benefit_meter_credit_refresh_snapshot",
							benefit_type: "meter_credit",
							benefit_metadata: {},
							properties: {},
						},
					],
					active_meters: [
						{
							id: "customer_meter_refresh_snapshot_webhook",
							created_at: "2026-04-07T12:47:51.954545Z",
							modified_at: "2026-04-09T03:59:32.439531Z",
							meter_id: "meter_new_webhook",
							consumed_units: 6,
							credited_units: 2178,
							balance: 2172,
						},
					],
					avatar_url: "https://example.com/avatar.png",
				},
			},
		});

		const snapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_userId", (q) => q.eq("userId", "user_refresh_snapshot_webhook" as Id<"users">))
				.unique(),
		);

		expect(snapshot).not.toBeNull();
		expect(snapshot!.subscription?.id).toBe("sub_refresh_snapshot_webhook");
		expect(snapshot!.meter?.id).toBe("meter_new_webhook");
		expect(snapshot!.meter?.amountDueCents).toBe(6);
		expect(snapshot!.meter?.balance).toBe(2172);
	});
});

describe("billing generate_checkout_link curated product", () => {
	test("rejects productIds that do not match the curated pay-as-you-go product", async () => {
		const t = test_convex();
		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim()!;
		const polarProductName = `${prefix}-${billing_PRODUCTS["Pay As You Go"].name}`;
		const polarProductId = "billing_curated_checkout_id";

		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: polarProductId,
				organizationId: "billing_test_org",
				name: polarProductName,
				description: null,
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [],
				medias: [],
				benefits: [],
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_curated_checkout" as Id<"users">,
			name: "Curated Checkout",
			email: "curated-checkout@test.local",
		});

		await expect(
			asUser.action(api.billing.generate_checkout_link, {
				productIds: ["some_other_product_id"],
				origin: "https://app.test",
				successUrl: "https://app.test/ok",
			}),
		).rejects.toThrow("Invalid checkout product");

		await expect(
			asUser.action(api.billing.generate_checkout_link, {
				productIds: [polarProductId, polarProductId],
				origin: "https://app.test",
				successUrl: "https://app.test/ok",
			}),
		).rejects.toThrow("Invalid checkout product");
	});
});

describe("billing change_current_subscription", () => {
	test("rejects plan changes", async () => {
		const t = test_convex();
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_no_plan_change" as Id<"users">,
			name: "No Plan Change",
			email: "no-plan-change@test.local",
		});

		await expect(asUser.action(api.billing.change_current_subscription, { productId: "any_product" })).rejects.toThrow(
			"Plan changes are not supported",
		);
	});
});

describe("ingest_usage_event", () => {
	beforeEach(() => {
		eventsIngestMock.mockReset();
	});

	afterEach(() => {
		eventsIngestMock.mockReset();
	});

	test("sends externalCustomerId and stable externalId", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		await t.action(internal.billing.ingest_usage_event, {
			userId: "user_drain_ok" as Id<"users">,
			eventId: `${billing_EVENTS.pressUsage}:u:test-page:1`,
			metadata: {
				amount: 1,
				source: "page-save",
				workspaceId: "ws",
				projectId: "pr",
				pageId: "page",
				yjsSequence: "1",
			},
		});

		expect(eventsIngestMock).toHaveBeenCalledTimes(1);
		const ingestCall = eventsIngestMock.mock.calls[0];
		expect(ingestCall).toBeDefined();
		const ingestPayload = ingestCall![1] as {
			events: Array<{ externalId: string; externalCustomerId: string; name: string }>;
		};
		expect(ingestPayload.events).toHaveLength(1);
		expect(ingestPayload.events[0]!.externalId).toBe(`${billing_EVENTS.pressUsage}:u:test-page:1`);
		expect(ingestPayload.events[0]!.externalCustomerId).toBe("user_drain_ok" as Id<"users">);
		expect("customerId" in ingestPayload.events[0]! && ingestPayload.events[0]!.customerId).toBeFalsy();
		expect(ingestPayload.events[0]!.name).toBe(billing_EVENTS.pressUsage);
	});

	test("throws when eventsIngest returns an error result", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: false,
			error: { statusCode: 400, message: "ingest_failed_test" } as never,
		});

		const t = test_convex();
		await expect(
			t.action(internal.billing.ingest_usage_event, {
				userId: "user_drain_fail" as Id<"users">,
				eventId: `${billing_EVENTS.pressUsage}:u:test-page:2`,
				metadata: {},
			}),
		).rejects.toThrow("ingest_failed_test");
	});
});
