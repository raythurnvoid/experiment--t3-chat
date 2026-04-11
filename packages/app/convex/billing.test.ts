import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import type { CustomerState } from "@polar-sh/sdk/models/components/customerstate.js";
import { BILLING_PRODUCTS, PRODUCTS } from "../shared/billing.ts";
import { billing_EVENTS } from "../server/billing.ts";
import { billing_usage_snapshot_fields_from_customer_state } from "./billing.ts";
import { api, components, internal } from "./_generated/api.js";
import { test_convex } from "./setup.test.ts";
import { customersGetState } from "@polar-sh/sdk/funcs/customersGetState.js";
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

vi.mock("@polar-sh/sdk/funcs/customersGetState.js", () => ({
	customersGetState: vi.fn(),
}));

const eventsIngestMock = vi.mocked(eventsIngest);
const customersGetStateMock = vi.mocked(customersGetState);

describe("billing_usage_snapshot_fields_from_customer_state", () => {
	test("maps the pay-as-you-go subscription meter and prefers Polar active meter balance", () => {
		const paygProductId = "payg_product_1";
		const now = 1_700_000_000_000;
		const subscriptionMeter = {
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			modifiedAt: null as Date | null,
			id: "sub_meter_1",
			consumedUnits: 12,
			creditedUnits: 2000,
			amount: 750,
			meterId: "meter_units",
		};
		const state = {
			type: "individual",
			id: "polar_customer_1",
			createdAt: new Date("2025-12-01T00:00:00.000Z"),
			modifiedAt: null,
			metadata: {},
			email: "u@test.local",
			emailVerified: true,
			name: null,
			billingAddress: null,
			taxId: null,
			organizationId: "org",
			deletedAt: null,
			avatarUrl: "",
			activeSubscriptions: [
				{
					id: "sub_1",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					modifiedAt: null,
					metadata: {},
					status: "active",
					amount: 1000,
					currency: "usd",
					recurringInterval: "month",
					currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
					currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
					trialStart: null,
					trialEnd: null,
					cancelAtPeriodEnd: false,
					canceledAt: null,
					startedAt: new Date("2026-01-01T00:00:00.000Z"),
					endsAt: null,
					productId: paygProductId,
					discountId: null,
					meters: [subscriptionMeter],
				},
			],
			grantedBenefits: [],
			activeMeters: [
				{
					id: "am_1",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					modifiedAt: null,
					meterId: "meter_units",
					consumedUnits: 12,
					creditedUnits: 2000,
					balance: 1988,
				},
			],
		} as unknown as CustomerState;

		const fields = billing_usage_snapshot_fields_from_customer_state({
			customerState: state,
			paygProductId,
			preferredMeterId: "meter_units",
			preferredMeterName: "Billable units",
			userId: "user_mapper_test" as Id<"users">,
			polarCustomerId: state.id,
			now,
		});

		expect(fields).not.toBeNull();
		if (!fields) {
			throw new Error("expected fields");
		}
		expect(fields.userId).toBe("user_mapper_test");
		expect(fields.polarCustomerId).toBe("polar_customer_1");
		expect(fields.subscriptionId).toBe("sub_1");
		expect(fields.productId).toBe(paygProductId);
		expect(fields.meterId).toBe("meter_units");
		expect(fields.meterName).toBe("Billable units");
		expect(fields.consumedUnits).toBe(12);
		expect(fields.creditedUnits).toBe(2000);
		expect(fields.balance).toBe(1988);
		expect(fields.amountDueCents).toBe(750);
		expect(fields.currency).toBe("usd");
		expect(fields.currentPeriodStart).toBe("2026-01-01T00:00:00.000Z");
		expect(fields.currentPeriodEnd).toBe("2026-02-01T00:00:00.000Z");
		expect(fields.lastSyncedAt).toBe(now);
	});

	test("returns null when there is no subscription for the pay-as-you-go product", () => {
		const state = {
			type: "individual",
			id: "c2",
			createdAt: new Date(),
			modifiedAt: null,
			metadata: {},
			email: "x@test",
			emailVerified: true,
			name: null,
			billingAddress: null,
			taxId: null,
			organizationId: "org_v2",
			deletedAt: null,
			avatarUrl: "",
			activeSubscriptions: [],
			grantedBenefits: [],
			activeMeters: [],
		} as unknown as CustomerState;

		const fields = billing_usage_snapshot_fields_from_customer_state({
			customerState: state,
			paygProductId: "missing_product",
			preferredMeterId: null,
			preferredMeterName: null,
			userId: "u1" as Id<"users">,
			polarCustomerId: "c2",
			now: Date.now(),
		});
		expect(fields).toBeNull();
	});

	test("returns null when more than one PAYG subscription exists in customer state", () => {
		const paygProductId = "payg_product_dup";
		const now = 1_700_000_000_000;
		const subShape = {
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			modifiedAt: null as Date | null,
			metadata: {},
			status: "active" as const,
			amount: 1000,
			currency: "usd",
			recurringInterval: "month" as const,
			currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
			currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
			trialStart: null,
			trialEnd: null,
			cancelAtPeriodEnd: false,
			canceledAt: null,
			startedAt: new Date("2026-01-01T00:00:00.000Z"),
			endsAt: null,
			productId: paygProductId,
			discountId: null,
			meters: [
				{
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					modifiedAt: null as Date | null,
					id: "sm_1",
					consumedUnits: 1,
					creditedUnits: 10,
					amount: 0,
					meterId: "meter_units",
				},
			],
		};
		const state = {
			type: "individual",
			id: "polar_customer_dup",
			createdAt: new Date("2025-12-01T00:00:00.000Z"),
			modifiedAt: null,
			metadata: {},
			email: "dup@test.local",
			emailVerified: true,
			name: null,
			billingAddress: null,
			taxId: null,
			organizationId: "org",
			deletedAt: null,
			avatarUrl: "",
			activeSubscriptions: [
				{ ...subShape, id: "sub_a" },
				{ ...subShape, id: "sub_b" },
			],
			grantedBenefits: [],
			activeMeters: [],
		} as unknown as CustomerState;

		const fields = billing_usage_snapshot_fields_from_customer_state({
			customerState: state,
			paygProductId,
			preferredMeterId: "meter_units",
			preferredMeterName: "Units",
			userId: "user_dup" as Id<"users">,
			polarCustomerId: state.id,
			now,
		});
		expect(fields).toBeNull();
	});
});

describe("billing get_pay_as_you_go_product", () => {
	test("returns ready when synced name matches POLAR_PRODUCTS_PREFIX pattern", async () => {
		const t = test_convex();
		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim();
		if (!prefix) {
			throw new Error("Expected POLAR_PRODUCTS_PREFIX from setup-env.test.ts");
		}
		const polarProductName = `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;
		const polarProductId = "billing_test_checkout_product_id";

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
			external_id: "user_billing_products_query" as Id<"users">,
			name: "Billing Products",
			email: "billing-products@test.local",
		});

		const configured = await asUser.query(internal.billing.get_pay_as_you_go_product, {});
		expect(configured?.id).toBe(polarProductId);
		expect(configured?.name).toBe(polarProductName);
	});

	test("returns ready when synced name matches the human-readable billing label", async () => {
		const t = test_convex();
		const polarProductId = "billing_test_checkout_product_label";

		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: polarProductId,
				organizationId: "billing_test_org",
				name: BILLING_PRODUCTS["Pay As You Go"].displayName,
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
			external_id: "user_billing_products_query_label" as Id<"users">,
			name: "Billing Products Label",
			email: "billing-products-label@test.local",
		});

		const configured = await asUser.query(internal.billing.get_pay_as_you_go_product, {});
		expect(configured?.id).toBe(polarProductId);
		expect(configured?.name).toBe(BILLING_PRODUCTS["Pay As You Go"].displayName);
	});

	test("returns null when no product name matches", async () => {
		const t = test_convex();

		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: "billing_other_product",
				organizationId: "billing_test_org",
				name: "some-unrelated-product-name",
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
			external_id: "user_billing_products_empty" as Id<"users">,
			name: "Billing Empty",
			email: "billing-empty@test.local",
		});

		const configured = await asUser.query(internal.billing.get_pay_as_you_go_product, {});
		expect(configured).toBeNull();
	});
});

type PaygSeed = {
	polarProductId: string;
	polarProductName: string;
};

async function seed_pay_as_you_go_product(
	t: ReturnType<typeof test_convex>,
	args: {
		polarProductId: string;
		description?: string | null;
		benefits?: Array<{
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
		}>;
	},
): Promise<PaygSeed> {
	const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim();
	if (!prefix) {
		throw new Error("Expected POLAR_PRODUCTS_PREFIX from setup-env.test.ts");
	}
	const polarProductName = `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;
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
					description: BILLING_PRODUCTS["Pay As You Go"].benefits["Free usage"].description,
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
			BILLING_PRODUCTS["Pay As You Go"].benefits["Free usage"].description,
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

describe("billing list_all_subscriptions", () => {
	test("returns empty array when unauthenticated", async () => {
		const t = test_convex();

		const subscriptions = await t.query(api.billing.list_all_subscriptions, {});

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

		const subscriptions = await asUser.query(api.billing.list_all_subscriptions, {});

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

		const subscriptions = await asUser.query(api.billing.list_all_subscriptions, {});
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
				startedAt: "2026-01-01T00:00:00.000Z",
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

		const subscriptions = await asUser.query(api.billing.list_all_subscriptions, {});
		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]?.productId).toBe(polarProductId);
		expect(subscriptions[0]?.status).toBe("active");
		expect(subscriptions[0]?.cancelAtPeriodEnd).toBe(true);
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

		const subscriptions = await asUser.query(api.billing.list_all_subscriptions, {});
		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]?.productId).toBe(polarProductId);
		expect(subscriptions[0]?.status).toBe("trialing");
	});
});

describe("billing get_usage", () => {
	test("returns null when unauthenticated", async () => {
		const t = test_convex();

		const usage = await t.query(api.billing.get_usage, {});

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

		const usage = await asUser.query(api.billing.get_usage, {});

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
				subscriptionId: "sub_usage_ready",
				productId: polarProductId,
				meterId: "meter_units",
				meterName: "Billable units",
				consumedUnits: 4,
				creditedUnits: 100,
				balance: 96,
				amountDueCents: 250,
				currency: "usd",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				lastSyncedAt: syncedAt,
				lastError: null,
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_usage_ready" as Id<"users">,
			name: "Usage Ready",
			email: "usage-ready@test.local",
		});

		const usage = await asUser.query(api.billing.get_usage, {});
		expect(usage).not.toBeNull();
		if (!usage) {
			throw new Error("Expected usage snapshot");
		}
		expect(usage.consumedUnits).toBe(4);
		expect(usage.amountDueCents).toBe(250);
		expect(usage.balance).toBe(96);
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

describe("refresh_usage_snapshot", () => {
	beforeEach(() => {
		customersGetStateMock.mockReset();
	});

	test("syncs usage from Polar state and clears prior failures", async () => {
		const t = test_convex();
		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim();
		if (!prefix) {
			throw new Error("Expected POLAR_PRODUCTS_PREFIX from setup-env.test.ts");
		}
		const polarProductId = "billing_refresh_snapshot_product";
		const polarProductName = `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;
		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: polarProductId,
				organizationId: "billing_test_org",
				name: polarProductName,
				description: "Metered plan used for refresh tests.",
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [
					{
						id: "price_refresh_snapshot",
						createdAt: "2026-01-01T00:00:00.000Z",
						modifiedAt: null,
						amountType: "metered_unit",
						isArchived: false,
						productId: polarProductId,
						priceCurrency: "eur",
						unitAmount: "1",
						recurringInterval: "month",
						meterId: "meter_units",
						meter: { id: "meter_units", name: "Billable units" },
					},
				],
				medias: [],
				benefits: [],
			},
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_refresh_snapshot",
			userId: "user_refresh_snapshot" as Id<"users">,
		});

		customersGetStateMock.mockResolvedValue({
			ok: true,
			value: {
				type: "individual",
				id: "cust_refresh_snapshot",
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				modifiedAt: null,
				metadata: {},
				email: "refresh-snapshot@test.local",
				emailVerified: true,
				name: null,
				billingAddress: null,
				taxId: null,
				organizationId: "billing_test_org",
				deletedAt: null,
				avatarUrl: "",
				activeSubscriptions: [
					{
						id: "sub_refresh_snapshot",
						createdAt: new Date("2026-01-01T00:00:00.000Z"),
						modifiedAt: null,
						metadata: {},
						status: "active",
						amount: 1000,
						currency: "eur",
						recurringInterval: "month",
						currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
						currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
						trialStart: null,
						trialEnd: null,
						cancelAtPeriodEnd: false,
						canceledAt: null,
						startedAt: new Date("2026-01-01T00:00:00.000Z"),
						endsAt: null,
						productId: polarProductId,
						discountId: null,
						meters: [
							{
								createdAt: new Date("2026-01-01T00:00:00.000Z"),
								modifiedAt: null,
								id: "meter_sub_refresh_snapshot",
								consumedUnits: 7,
								creditedUnits: 2000,
								amount: 700,
								meterId: "meter_units",
							},
						],
					},
				],
				grantedBenefits: [],
				activeMeters: [
					{
						id: "active_meter_refresh_snapshot",
						createdAt: new Date("2026-01-01T00:00:00.000Z"),
						modifiedAt: null,
						meterId: "meter_units",
						consumedUnits: 7,
						creditedUnits: 2000,
						balance: 1993,
					},
				],
			} as CustomerState,
		});

		const refreshResult = await t.action(internal.billing.refresh_usage_snapshot, {
			userId: "user_refresh_snapshot" as Id<"users">,
		});
		expect(refreshResult).toBeNull();

		const snapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_userId", (q) => q.eq("userId", "user_refresh_snapshot" as Id<"users">))
				.unique(),
		);
		expect(snapshot).not.toBeNull();
		expect(snapshot!.polarCustomerId).toBe("cust_refresh_snapshot");
		expect(snapshot!.amountDueCents).toBe(700);
		expect(snapshot!.balance).toBe(1993);
		expect(customersGetStateMock).toHaveBeenCalledTimes(1);
		expect(customersGetStateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "cust_refresh_snapshot",
		});
	});
});

describe("billing generate_checkout_link curated product", () => {
	test("rejects productIds that do not match the curated pay-as-you-go product", async () => {
		const t = test_convex();
		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim()!;
		const polarProductName = `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;
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

describe("refresh_usage_snapshot catalog guard", () => {
	test("clears the cached snapshot when pay-as-you-go catalog is not ready", async () => {
		const t = test_convex();
		const userId = "user_refresh_catalog_not_ready" as Id<"users">;
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_snapshots", {
				userId,
				polarCustomerId: "cust_catalog_guard",
				subscriptionId: "sub_catalog_guard",
				productId: "prod_catalog_guard",
				meterId: "meter_catalog_guard",
				meterName: "Catalog guard meter",
				consumedUnits: 3,
				creditedUnits: 2000,
				balance: 1997,
				amountDueCents: 300,
				currency: "eur",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				lastSyncedAt: Date.now(),
				lastError: null,
			});
		});

		const refreshResult = await t.action(internal.billing.refresh_usage_snapshot, {
			userId,
		});
		expect(refreshResult).toBeNull();

		const snapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_userId", (q) => q.eq("userId", userId))
				.unique(),
		);
		expect(snapshot).toBeNull();
	});
});
