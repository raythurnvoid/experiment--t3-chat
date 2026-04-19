import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { Workpool } from "@convex-dev/workpool";
import { api, components, internal } from "./_generated/api.js";
import { billing } from "./billing.ts";
import { test_convex } from "./setup.test.ts";
import { customersCreate } from "@polar-sh/sdk/funcs/customersCreate.js";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { subscriptionsCreate } from "@polar-sh/sdk/funcs/subscriptionsCreate.js";
import { subscriptionsRevoke } from "@polar-sh/sdk/funcs/subscriptionsRevoke.js";
import { subscriptionsUpdate } from "@polar-sh/sdk/funcs/subscriptionsUpdate.js";
import { AlreadyCanceledSubscription } from "@polar-sh/sdk/models/errors/alreadycanceledsubscription.js";
import { PaymentFailed } from "@polar-sh/sdk/models/errors/paymentfailed.js";
import { UnexpectedClientError } from "@polar-sh/sdk/models/errors/httpclienterrors.js";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound.js";
import { SubscriptionLocked } from "@polar-sh/sdk/models/errors/subscriptionlocked.js";
import type { Id } from "./_generated/dataModel.js";

vi.mock("@polar-sh/sdk/core.js", () => ({
	PolarCore: class PolarCoreMock {
		constructor(_args: unknown) {}
	},
}));

vi.mock("@polar-sh/sdk/funcs/eventsIngest.js", () => ({
	eventsIngest: vi.fn(),
}));

vi.mock("@polar-sh/sdk/funcs/customersCreate.js", () => ({
	customersCreate: vi.fn(),
}));

vi.mock("@polar-sh/sdk/funcs/subscriptionsCreate.js", () => ({
	subscriptionsCreate: vi.fn(),
}));

vi.mock("@polar-sh/sdk/funcs/subscriptionsRevoke.js", () => ({
	subscriptionsRevoke: vi.fn(),
}));

vi.mock("@polar-sh/sdk/funcs/subscriptionsUpdate.js", () => ({
	subscriptionsUpdate: vi.fn(),
}));

const customersCreateMock = vi.mocked(customersCreate);
const eventsIngestMock = vi.mocked(eventsIngest);
const subscriptionsCreateMock = vi.mocked(subscriptionsCreate);
const subscriptionsRevokeMock = vi.mocked(subscriptionsRevoke);
const subscriptionsUpdateMock = vi.mocked(subscriptionsUpdate);

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
	const polarProductName = billing_PRODUCTS["Pay As You Go"].name;
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

async function seed_free_product(
	t: ReturnType<typeof test_convex>,
	args: {
		polarProductId: string;
		description?: string | null;
		benefits?: BillingSeedBenefit[];
	},
): Promise<BillingSeed> {
	const polarProductName = billing_PRODUCTS.Free.name;
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
					amountType: "free",
					isArchived: false,
					productId: args.polarProductId,
					priceCurrency: "eur",
					recurringInterval: "month",
				},
			],
			medias: [],
			benefits: args.benefits ?? [
				{
					id: "benefit_free_meter_credit",
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					type: "meter_credit",
					description: "Free Included Usage",
					selectable: false,
					deletable: false,
					organizationId: "billing_test_org",
					properties: { units: 1000, rollover: true, meterId: "meter_press_usage" },
				},
			],
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
	const polarProductName = billing_PRODUCTS.Pro.name;
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
					description: "Pro Included Usage",
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

async function seed_user_id(t: ReturnType<typeof test_convex>) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("users", {
			clerkUserId: null,
		});
	});
}

async function get_cancel_polar_subscription_job(t: ReturnType<typeof test_convex>, userId: Id<"users">) {
	return await t.run((ctx) =>
		ctx.db
			.query("billing_cancel_polar_subscription_jobs")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.first(),
	);
}

async function seed_subscription(
	t: ReturnType<typeof test_convex>,
	args: {
		userId: string;
		customerId: string;
		subscriptionId: string;
		polarProductId: string;
		status?: "active" | "trialing";
		pendingUpdate?: {
			id: string;
			appliesAt: string;
			productId: string | null;
			seats: number | null;
		} | null;
	},
) {
	await t.mutation(components.polar.lib.insertCustomer, {
		id: args.customerId,
		userId: args.userId,
	});

	await t.mutation(components.polar.lib.createSubscription, {
		subscription: {
			id: args.subscriptionId,
			customerId: args.customerId,
			productId: args.polarProductId,
			checkoutId: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-02T00:00:00.000Z",
			amount: 1000,
			currency: "eur",
			recurringInterval: "month",
			status: args.status ?? "active",
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
			cancelAtPeriodEnd: false,
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: null,
			metadata: {},
			pendingUpdate: args.pendingUpdate ?? null,
		},
	});
}

function create_updated_polar_subscription(args: {
	subscriptionId: string;
	customerId: string;
	productId: string;
	pendingUpdate?: {
		id: string;
		appliesAt: string;
		productId: string | null;
		seats: number | null;
	} | null;
}) {
	return {
		id: args.subscriptionId,
		customerId: args.customerId,
		productId: args.productId,
		checkoutId: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		modifiedAt: new Date("2026-01-03T00:00:00.000Z"),
		amount: 1000,
		currency: "eur",
		recurringInterval: "month",
		recurringIntervalCount: 1,
		status: "active",
		currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
		currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
		trialStart: null,
		trialEnd: null,
		cancelAtPeriodEnd: false,
		canceledAt: null,
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		endsAt: null,
		endedAt: null,
		discountId: null,
		seats: null,
		customerCancellationReason: null,
		customerCancellationComment: null,
		metadata: {},
		customFieldData: {},
		pendingUpdate: args.pendingUpdate
			? {
					id: args.pendingUpdate.id,
					createdAt: new Date("2026-01-03T00:00:00.000Z"),
					modifiedAt: null,
					appliesAt: new Date(args.pendingUpdate.appliesAt),
					productId: args.pendingUpdate.productId,
					seats: args.pendingUpdate.seats,
				}
			: null,
	};
}

beforeEach(() => {
	customersCreateMock.mockReset();
	eventsIngestMock.mockReset();
	subscriptionsCreateMock.mockReset();
	subscriptionsRevokeMock.mockReset();
	subscriptionsUpdateMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

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

	test("returns both known products from list_products", async () => {
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
					return benefit.description === "Pro Included Usage";
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
					description: "Free Usage",
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
		expect(paygProduct?.benefits?.map((benefit) => benefit.description)).toContain("Free Usage");
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

describe("billing get_current_user_subscription", () => {
	test("returns null when unauthenticated", async () => {
		const t = test_convex();

		const subscription = await t.query(api.billing.get_current_user_subscription, {});

		expect(subscription).toBeNull();
	});

	test("returns null when the user has no subscriptions", async () => {
		const t = test_convex();
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_subscription_empty" as Id<"users">,
			name: "Subscription Empty",
			email: "subscription-empty@test.local",
		});

		const subscription = await asUser.query(api.billing.get_current_user_subscription, {});

		expect(subscription).toBeNull();
	});

	test("returns null when the user only has ended subscriptions", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_current_subscription_prod_ended",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_current_subscription_ended",
			userId: "user_billing_current_subscription_ended",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_current_subscription_ended",
				customerId: "cust_current_subscription_ended",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
				recurringInterval: "month",
				status: "canceled",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: "2026-02-01T00:00:00.000Z",
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_current_subscription_ended" as Id<"users">,
			name: "Current Subscription Ended",
			email: "current-subscription-ended@test.local",
		});

		const subscription = await asUser.query(api.billing.get_current_user_subscription, {});

		expect(subscription).toBeNull();
	});

	test("returns the current active subscription", async () => {
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

		const subscription = await asUser.query(api.billing.get_current_user_subscription, {});
		expect(subscription?.productId).toBe(polarProductId);
		expect(subscription?.status).toBe("active");
		expect(subscription?.startedAt).toBe("2026-01-01T00:00:00.000Z");
		expect("product" in (subscription ?? {})).toBe(false);
	});

	test("returns the current cancel_at_period_end subscription", async () => {
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

		const subscription = await asUser.query(api.billing.get_current_user_subscription, {});
		expect(subscription?.productId).toBe(polarProductId);
		expect(subscription?.status).toBe("active");
		expect(subscription?.cancelAtPeriodEnd).toBe(true);
		expect(subscription?.canceledAt).toBe("2026-01-15T00:00:00.000Z");
		expect(subscription?.endsAt).toBe("2026-02-01T00:00:00.000Z");
	});

	test("returns the current trialing subscription", async () => {
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

		const subscription = await asUser.query(api.billing.get_current_user_subscription, {});
		expect(subscription?.productId).toBe(polarProductId);
		expect(subscription?.status).toBe("trialing");
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
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_usage_prod_ready",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_usage_ready",
			userId,
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
				userId,
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
			external_id: userId,
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

describe("billing bootstrap_free_subscription", () => {
	test("creates a Polar customer and Free subscription for a newly resolved user", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_bootstrap_free_product",
		});

		customersCreateMock.mockResolvedValue({
			ok: true,
			value: {
				id: "cust_bootstrap_free",
			},
		} as never);
		subscriptionsCreateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_bootstrap_free",
				customerId: "cust_bootstrap_free",
				productId: polarProductId,
			}),
		} as never);

		const result = await t.action(internal.billing.bootstrap_free_subscription, {
			userId,
			email: "bootstrap-free@test.local",
		});

		expect(result).toBeNull();
		expect(customersCreateMock).toHaveBeenCalledWith(expect.anything(), {
			externalId: userId,
			email: "bootstrap-free@test.local",
		});
		expect(subscriptionsCreateMock).toHaveBeenCalledWith(expect.anything(), {
			customerId: "cust_bootstrap_free",
			productId: polarProductId,
		});

		const [customer, subscription] = await Promise.all([
			t.query(components.polar.lib.getCustomerByUserId, { userId }),
			t.query(components.polar.lib.getCurrentSubscription, { userId }),
		]);
		expect(customer?.id).toBe("cust_bootstrap_free");
		expect(subscription?.id).toBe("sub_bootstrap_free");
		expect(subscription?.productId).toBe(polarProductId);
	});

	test("skips bootstrap when the user already has a current subscription", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await seed_free_product(t, {
			polarProductId: "billing_bootstrap_existing_free_product",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_bootstrap_existing_pro_product",
		});

		await seed_subscription(t, {
			userId,
			customerId: "cust_bootstrap_existing",
			subscriptionId: "sub_bootstrap_existing",
			polarProductId: polarProProductId,
		});

		const result = await t.action(internal.billing.bootstrap_free_subscription, {
			userId,
			email: "bootstrap-existing@test.local",
		});

		expect(result).toBeNull();
		expect(customersCreateMock).not.toHaveBeenCalled();
		expect(subscriptionsCreateMock).not.toHaveBeenCalled();
	});

	test("throws when bootstrap fails so the workpool can retry it", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await seed_free_product(t, {
			polarProductId: "billing_bootstrap_retry_free_product",
		});

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		customersCreateMock.mockResolvedValue({
			ok: false,
			error: new UnexpectedClientError("bootstrap customer exploded"),
		} as never);

		await expect(
			t.action(internal.billing.bootstrap_free_subscription, {
				userId,
				email: "bootstrap-retry@test.local",
			}),
		).rejects.toThrow("Failed to bootstrap Free subscription");
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Failed to bootstrap Free subscription",
			expect.objectContaining({
				error: expect.objectContaining({
					data: expect.objectContaining({
						message: "Failed to create Polar customer",
						cause: expect.objectContaining({
							message: "bootstrap customer exploded",
							name: "UnexpectedClientError",
						}),
						data: expect.objectContaining({
							email: "bootstrap-retry@test.local",
							userId,
						}),
					}),
				}),
				userId,
			}),
		);
	});
});

describe("billing generate_checkout_link url validation", () => {
	test("returns nay for invalid checkout URLs", async () => {
		const t = test_convex();

		const result = await t.action(api.billing.generate_checkout_link, {
			productId: "prod_x",
			origin: "not-a-url",
			successUrl: "https://app.test/ok",
		});

		expect(result._nay?.message).toBe("Invalid checkout URL");
	});

	test("returns nay when origin is not allowed", async () => {
		const t = test_convex();

		const result = await t.action(api.billing.generate_checkout_link, {
			productId: "prod_x",
			origin: "https://evil.test",
			successUrl: "https://app.test/ok",
		});

		expect(result._nay?.message).toBe("Origin is not allowed for checkout");
	});

	test("returns nay when success URL is not allowed", async () => {
		const t = test_convex();

		const result = await t.action(api.billing.generate_checkout_link, {
			productId: "prod_x",
			origin: "https://app.test",
			successUrl: "https://evil.test/ok",
		});

		expect(result._nay?.message).toBe("Success URL is not allowed for checkout");
	});
});

describe("billing generate_checkout_link auth", () => {
	test("returns nay for anonymous identity before Polar SDK", async () => {
		const t = test_convex();
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: "user_anon_checkout",
			name: "Anon Checkout",
		});

		const result = await asAnonymous.action(api.billing.generate_checkout_link, {
			productId: "prod_x",
			origin: "https://app.test",
			successUrl: "https://app.test/ok",
		});

		expect(result._nay?.message).toBe("A signed-in account is required for checkout");
	});

	test("throws a Convex impossible-state error for Clerk identity without email", async () => {
		const t = test_convex();
		const asUserNoEmail = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_no_email_checkout" as Id<"users">,
			name: "No Email",
			email: undefined,
		});

		await expect(
			asUserNoEmail.action(api.billing.generate_checkout_link, {
				productId: "prod_x",
				origin: "https://app.test",
				successUrl: "https://app.test/ok",
			}),
		).rejects.toThrow("Email required for signed-in users");
	});
});

describe("handle_polar_customer_state_update", () => {
	test("writes the usage snapshot directly from the active subscription meter in the webhook payload", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const polarProductId = "billing_refresh_snapshot_webhook_product";
		const polarProductName = billing_PRODUCTS["Pay As You Go"].name;
		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_refresh_snapshot_webhook" as never);

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
						userId,
					},
					external_id: userId,
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
				.withIndex("by_userId", (q) => q.eq("userId", userId))
				.unique(),
		);

		expect(snapshot).not.toBeNull();
		expect(snapshot!.subscription?.id).toBe("sub_refresh_snapshot_webhook");
		expect(snapshot!.meter?.id).toBe("meter_new_webhook");
		expect(snapshot!.meter?.amountDueCents).toBe(6);
		expect(snapshot!.meter?.balance).toBe(2172);
	});

	test("throws when the webhook payload contains multiple active subscriptions", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_refresh_snapshot_multiple_active_product",
		});

		await expect(
			t.mutation(internal.billing.handle_polar_customer_state_update, {
				payload: {
					type: "customer.state_changed",
					timestamp: "2026-04-13T03:20:41.064Z",
					data: {
						id: "cust_refresh_snapshot_multiple_active",
						external_id: userId,
						active_subscriptions: [
							{
								id: "sub_refresh_snapshot_multiple_active_1",
								product_id: polarProductId,
								currency: "eur",
								current_period_start: "2026-04-13T03:20:38.364476Z",
								current_period_end: "2026-05-13T03:20:38.364476Z",
								meters: [],
							},
							{
								id: "sub_refresh_snapshot_multiple_active_2",
								product_id: polarProductId,
								currency: "eur",
								current_period_start: "2026-04-13T03:20:38.364476Z",
								current_period_end: "2026-05-13T03:20:38.364476Z",
								meters: [],
							},
						],
						active_meters: [],
					},
				},
			}),
		).rejects.toThrow("Multiple active subscriptions are not supported");

		const snapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_userId", (q) => q.eq("userId", userId))
				.unique(),
		);
		expect(snapshot).toBeNull();
	});

	test("writes the usage snapshot from the active customer meter for credits-only Free plans", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_refresh_snapshot_free_product",
		});
		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_refresh_snapshot_free" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-13T03:20:41.064Z",
				data: {
					id: "cust_refresh_snapshot_free",
					external_id: userId,
					active_subscriptions: [
						{
							id: "sub_refresh_snapshot_free",
							product_id: polarProductId,
							currency: "eur",
							current_period_start: "2026-04-13T03:20:38.364476Z",
							current_period_end: "2026-05-13T03:20:38.364476Z",
							meters: [],
						},
					],
					active_meters: [
						{
							meter_id: "meter_press_usage",
							consumed_units: 240,
							credited_units: 1000,
							balance: 760,
						},
					],
				},
			},
		});

		const snapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_userId", (q) => q.eq("userId", userId))
				.unique(),
		);

		expect(snapshot).not.toBeNull();
		expect(snapshot!.subscription?.id).toBe("sub_refresh_snapshot_free");
		expect(snapshot!.meter).toEqual({
			id: "meter_press_usage",
			consumedUnits: 240,
			creditedUnits: 1000,
			balance: 760,
			amountDueCents: 0,
		});
	});

	test("throws when an active subscription has no resolvable usage meter", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_refresh_snapshot_missing_meter_product",
		});

		await expect(
			t.mutation(internal.billing.handle_polar_customer_state_update, {
				payload: {
					type: "customer.state_changed",
					timestamp: "2026-04-13T03:20:41.064Z",
					data: {
						id: "cust_refresh_snapshot_missing_meter",
						external_id: userId,
						active_subscriptions: [
							{
								id: "sub_refresh_snapshot_missing_meter",
								product_id: polarProductId,
								currency: "eur",
								current_period_start: "2026-04-13T03:20:38.364476Z",
								current_period_end: "2026-05-13T03:20:38.364476Z",
								meters: [],
							},
						],
						active_meters: [],
					},
				},
			}),
		).rejects.toThrow("Failed to resolve usage meter for active subscription");

		const snapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_userId", (q) => q.eq("userId", userId))
				.unique(),
		);
		expect(snapshot).toBeNull();
	});
});

describe("billing generate_checkout_link product id", () => {
	test("returns nay when productId does not match a synced non-archived Polar product", async () => {
		const t = test_convex();
		const polarProductName = billing_PRODUCTS["Pay As You Go"].name;
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

		const result = await asUser.action(api.billing.generate_checkout_link, {
			productId: "some_other_product_id",
			origin: "https://app.test",
			successUrl: "https://app.test/ok",
		});

		expect(result._nay?.message).toBe("Invalid checkout product");
	});
});

describe("billing generate_checkout_link create session", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns nay when Polar checkout session creation fails", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_checkout_session_fail",
		});

		vi.spyOn(billing, "createCheckoutSession").mockRejectedValue(new Error("polar checkout exploded"));

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_checkout_session_fail" as Id<"users">,
			name: "Checkout Session Fail",
			email: "checkout-session-fail@test.local",
		});

		const result = await asUser.action(api.billing.generate_checkout_link, {
			productId: polarProductId,
			origin: "https://app.test",
			successUrl: "https://app.test/ok",
		});

		expect(result._nay?.message).toBe("Failed to create a checkout link");
	});

	test("returns yay with the checkout URL", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_checkout_session_success",
		});

		vi.spyOn(billing, "createCheckoutSession").mockResolvedValue({
			url: "https://checkout.test/session",
		} as never);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_checkout_session_success" as Id<"users">,
			name: "Checkout Session Success",
			email: "checkout-session-success@test.local",
		});

		const result = await asUser.action(api.billing.generate_checkout_link, {
			productId: polarProductId,
			origin: "https://app.test",
			successUrl: "https://app.test/ok",
			locale: "it",
		});

		expect(result._yay?.url).toBe("https://checkout.test/session?locale=it");
	});

	test("forwards subscriptionId to checkout creation", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pro_product(t, {
			polarProductId: "billing_checkout_session_upgrade_from_free",
		});

		const createCheckoutSessionSpy = vi.spyOn(billing, "createCheckoutSession").mockResolvedValue({
			url: "https://checkout.test/session",
		} as never);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_checkout_session_upgrade_from_free" as Id<"users">,
			name: "Checkout Session Upgrade From Free",
			email: "checkout-session-upgrade-from-free@test.local",
		});

		const result = await asUser.action(api.billing.generate_checkout_link, {
			productId: polarProductId,
			subscriptionId: "sub_free_upgrade",
			origin: "https://app.test",
			successUrl: "https://app.test/ok",
		});

		expect(result._yay?.url).toBe("https://checkout.test/session");
		expect(createCheckoutSessionSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				productIds: [polarProductId],
				subscriptionId: "sub_free_upgrade",
			}),
		);
	});
});

describe("billing change_current_subscription", () => {
	beforeEach(() => {
		subscriptionsUpdateMock.mockReset();
	});

	afterEach(() => {
		subscriptionsUpdateMock.mockReset();
	});

	test("upgrades immediately with invoice proration and updates the stored subscription", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_payg_upgrade",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_pro_upgrade",
		});

		await seed_subscription(t, {
			userId: "user_upgrade_plan",
			customerId: "cust_upgrade_plan",
			subscriptionId: "sub_upgrade_plan",
			polarProductId: polarPaygProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_upgrade_plan",
				customerId: "cust_upgrade_plan",
				productId: polarProProductId,
			}) as never,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_upgrade_plan" as Id<"users">,
			name: "Upgrade Plan",
			email: "upgrade-plan@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarProProductId,
		});

		expect(result).toEqual({
			_yay: {
				changeKind: "upgrade",
				prorationBehavior: "invoice",
				targetProductId: polarProProductId,
				pendingUpdateAppliesAt: null,
			},
		});
		expect(subscriptionsUpdateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_upgrade_plan",
			subscriptionUpdate: {
				productId: polarProProductId,
				prorationBehavior: "invoice",
			},
		});

		const storedSubscription = await t.query(components.polar.lib.getSubscription, {
			id: "sub_upgrade_plan",
		});
		expect(storedSubscription?.productId).toBe(polarProProductId);
		expect(storedSubscription?.pendingUpdate).toBeNull();
	});

	test("schedules downgrades for the next period and stores pendingUpdate", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_payg_downgrade",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_pro_downgrade",
		});

		await seed_subscription(t, {
			userId: "user_downgrade_plan",
			customerId: "cust_downgrade_plan",
			subscriptionId: "sub_downgrade_plan",
			polarProductId: polarProProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_downgrade_plan",
				customerId: "cust_downgrade_plan",
				productId: polarProProductId,
				pendingUpdate: {
					id: "pending_downgrade_plan",
					appliesAt: "2026-02-01T00:00:00.000Z",
					productId: polarPaygProductId,
					seats: null,
				},
			}) as never,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_downgrade_plan" as Id<"users">,
			name: "Downgrade Plan",
			email: "downgrade-plan@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarPaygProductId,
		});

		expect(result).toEqual({
			_yay: {
				changeKind: "downgrade",
				prorationBehavior: "next_period",
				targetProductId: polarPaygProductId,
				pendingUpdateAppliesAt: "2026-02-01T00:00:00.000Z",
			},
		});
		expect(subscriptionsUpdateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_downgrade_plan",
			subscriptionUpdate: {
				productId: polarPaygProductId,
				prorationBehavior: "next_period",
			},
		});

		const storedSubscription = await t.query(components.polar.lib.getSubscription, {
			id: "sub_downgrade_plan",
		});
		expect(storedSubscription?.productId).toBe(polarProProductId);
		expect(storedSubscription?.pendingUpdate).toEqual({
			id: "pending_downgrade_plan",
			appliesAt: "2026-02-01T00:00:00.000Z",
			productId: polarPaygProductId,
			seats: null,
		});
	});

	test("schedules paid to Free downgrades for the next period", async () => {
		const t = test_convex();
		const { polarProductId: polarFreeProductId } = await seed_free_product(t, {
			polarProductId: "billing_change_free_downgrade",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_pro_to_free",
		});

		await seed_subscription(t, {
			userId: "user_downgrade_free_plan",
			customerId: "cust_downgrade_free_plan",
			subscriptionId: "sub_downgrade_free_plan",
			polarProductId: polarProProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_downgrade_free_plan",
				customerId: "cust_downgrade_free_plan",
				productId: polarProProductId,
				pendingUpdate: {
					id: "pending_downgrade_free_plan",
					appliesAt: "2026-02-01T00:00:00.000Z",
					productId: polarFreeProductId,
					seats: null,
				},
			}) as never,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_downgrade_free_plan" as Id<"users">,
			name: "Downgrade Free Plan",
			email: "downgrade-free-plan@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarFreeProductId,
		});

		expect(result).toEqual({
			_yay: {
				changeKind: "downgrade",
				prorationBehavior: "next_period",
				targetProductId: polarFreeProductId,
				pendingUpdateAppliesAt: "2026-02-01T00:00:00.000Z",
			},
		});
		expect(subscriptionsUpdateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_downgrade_free_plan",
			subscriptionUpdate: {
				productId: polarFreeProductId,
				prorationBehavior: "next_period",
			},
		});
	});

	test("returns nay when upgrading from Free", async () => {
		const t = test_convex();
		const { polarProductId: polarFreeProductId } = await seed_free_product(t, {
			polarProductId: "billing_change_current_free",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_target_pro_from_free",
		});

		await seed_subscription(t, {
			userId: "user_current_free",
			customerId: "cust_current_free",
			subscriptionId: "sub_current_free",
			polarProductId: polarFreeProductId,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_current_free" as Id<"users">,
			name: "Current Free",
			email: "current-free@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarProProductId,
		});

		expect(result._nay?.message).toBe("Use checkout to upgrade from Free");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});

	test("returns nay when the user selects the current product", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_same_plan",
		});

		await seed_subscription(t, {
			userId: "user_same_plan",
			customerId: "cust_same_plan",
			subscriptionId: "sub_same_plan",
			polarProductId: polarPaygProductId,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_same_plan" as Id<"users">,
			name: "Same Plan",
			email: "same-plan@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarPaygProductId,
		});

		expect(result._nay?.message).toBe("You're already on this plan");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});

	test("returns nay when the target product is unknown", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_unknown_current",
		});

		await seed_subscription(t, {
			userId: "user_unknown_target",
			customerId: "cust_unknown_target",
			subscriptionId: "sub_unknown_target",
			polarProductId: polarPaygProductId,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_unknown_target" as Id<"users">,
			name: "Unknown Target",
			email: "unknown-target@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: "missing_product",
		});

		expect(result._nay?.message).toBe("Invalid target plan");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});

	test("returns nay for anonymous users", async () => {
		const t = test_convex();
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: "user_change_subscription_anonymous",
			name: "Anonymous Plan Change",
		});

		const result = await asAnonymous.action(api.billing.change_current_subscription, {
			productId: "any_product",
		});

		expect(result._nay?.message).toBe("A signed-in account is required for billing");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});

	test("returns nay when the user has no current subscription", async () => {
		const t = test_convex();
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_without_subscription" as Id<"users">,
			name: "No Current Subscription",
			email: "no-current-subscription@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: "any_product",
		});

		expect(result._nay?.message).toBe("No active subscription found");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});

	test("returns a payment failure as a user-safe nay", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_payment_failed_current",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_payment_failed_target",
		});

		await seed_subscription(t, {
			userId: "user_payment_failed",
			customerId: "cust_payment_failed",
			subscriptionId: "sub_payment_failed",
			polarProductId: polarPaygProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new PaymentFailed(
				{
					error: "PaymentFailed",
					detail: "Card was declined",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_payment_failed"),
					response: new Response(JSON.stringify({ error: "PaymentFailed" }), { status: 402 }),
					body: JSON.stringify({ error: "PaymentFailed" }),
				},
			),
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_payment_failed" as Id<"users">,
			name: "Payment Failed",
			email: "payment-failed@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarProProductId,
		});

		expect(result._nay?.message).toBe("Payment failed while updating the subscription");
	});

	test("returns a subscription lock as a user-safe nay", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_locked_current",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_locked_target",
		});

		await seed_subscription(t, {
			userId: "user_subscription_locked",
			customerId: "cust_subscription_locked",
			subscriptionId: "sub_subscription_locked",
			polarProductId: polarPaygProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new SubscriptionLocked(
				{
					error: "SubscriptionLocked",
					detail: "Subscription is locked",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_subscription_locked"),
					response: new Response(JSON.stringify({ error: "SubscriptionLocked" }), { status: 409 }),
					body: JSON.stringify({ error: "SubscriptionLocked" }),
				},
			),
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_subscription_locked" as Id<"users">,
			name: "Subscription Locked",
			email: "subscription-locked@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarProProductId,
		});

		expect(result._nay?.message).toBe("Subscription is locked and cannot be changed right now");
	});

	test("returns a generic nay for unexpected Polar errors", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_generic_error_current",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_generic_error_target",
		});

		await seed_subscription(t, {
			userId: "user_generic_plan_change_error",
			customerId: "cust_generic_plan_change_error",
			subscriptionId: "sub_generic_plan_change_error",
			polarProductId: polarPaygProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new UnexpectedClientError("polar change exploded"),
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_generic_plan_change_error" as Id<"users">,
			name: "Generic Plan Change Error",
			email: "generic-plan-change-error@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarProProductId,
		});

		expect(result._nay?.message).toBe("Failed to change the subscription");
	});
});

describe("billing revoke_subscription", () => {
	beforeEach(() => {
		subscriptionsRevokeMock.mockReset();
	});

	afterEach(() => {
		subscriptionsRevokeMock.mockReset();
	});

	test("returns not found when the user has no current subscription", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		const result = await t.action(internal.billing.revoke_subscription, {
			userId,
		});

		expect(result._nay?.message).toBe("Subscription not found");
	});

	test("revokes the current subscription for the target user", async () => {
		subscriptionsRevokeMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_revoke_prod_active",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_billing_revoke_active",
			userId,
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_billing_revoke_active",
				customerId: "cust_billing_revoke_active",
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

		const result = await t.action(internal.billing.revoke_subscription, {
			userId,
		});

		expect(result).toEqual({ _yay: null });
		expect(subscriptionsRevokeMock).toHaveBeenCalledTimes(1);
		expect(subscriptionsRevokeMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_billing_revoke_active",
		});
	});

	test("returns already canceled when Polar reports an already canceled subscription", async () => {
		subscriptionsRevokeMock.mockResolvedValue({
			ok: false,
			error: new AlreadyCanceledSubscription(
				{
					error: "AlreadyCanceledSubscription",
					detail: "Subscription already canceled",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_billing_revoke_already_canceled"),
					response: new Response(JSON.stringify({ error: "AlreadyCanceledSubscription" }), { status: 403 }),
					body: JSON.stringify({ error: "AlreadyCanceledSubscription" }),
				},
			),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_revoke_prod_already_canceled",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_billing_revoke_already_canceled",
			userId,
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_billing_revoke_already_canceled",
				customerId: "cust_billing_revoke_already_canceled",
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

		const result = await t.action(internal.billing.revoke_subscription, {
			userId,
		});

		expect(result._nay?.message).toBe("Subscription already canceled");
	});

	test("returns not found when Polar reports the subscription is missing", async () => {
		subscriptionsRevokeMock.mockResolvedValue({
			ok: false,
			error: new ResourceNotFound(
				{
					error: "ResourceNotFound",
					detail: "Subscription not found",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_billing_revoke_resource_not_found"),
					response: new Response(JSON.stringify({ error: "ResourceNotFound" }), { status: 404 }),
					body: JSON.stringify({ error: "ResourceNotFound" }),
				},
			),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_revoke_prod_resource_not_found",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_billing_revoke_resource_not_found",
			userId,
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_billing_revoke_resource_not_found",
				customerId: "cust_billing_revoke_resource_not_found",
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

		const result = await t.action(internal.billing.revoke_subscription, {
			userId,
		});

		expect(result._nay?.message).toBe("Subscription not found");
	});

	test("throws when Polar returns an unexpected revoke error", async () => {
		subscriptionsRevokeMock.mockResolvedValue({
			ok: false,
			error: new UnexpectedClientError("polar revoke exploded"),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_revoke_prod_unexpected_error",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_billing_revoke_unexpected_error",
			userId,
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_billing_revoke_unexpected_error",
				customerId: "cust_billing_revoke_unexpected_error",
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

		await expect(
			t.action(internal.billing.revoke_subscription, {
				userId,
			}),
		).rejects.toThrow("Failed to revoke subscription");
	});
});

describe("billing schedule_polar_subscription_period_end_cancellation", () => {
	test("schedules a billing-owned row and enqueues the retryable cancellation with the configured backoff", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		const enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async function (
			this: Workpool,
			_ctx,
			fn,
			fnArgs,
			options,
		) {
			expect(this.options.defaultRetryBehavior).toEqual({
				initialBackoffMs: 10 * 60 * 1000,
				base: 1.2,
				maxAttempts: Number.POSITIVE_INFINITY,
			});
			expect(fn).toBeDefined();
			expect(fnArgs).toEqual({
				userId,
				subscriptionId: "sub_schedule_initial",
			});
			expect(options?.context).toEqual({
				userId,
			});
			expect(options?.onComplete).toBeDefined();

			return "work_schedule_initial" as never;
		});

		await t.action(internal.billing.schedule_polar_subscription_period_end_cancellation, {
			userId,
			subscriptionId: "sub_schedule_initial",
		});

		const row = await get_cancel_polar_subscription_job(t, userId);

		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect(row?.jobId).toBe("work_schedule_initial");
		expect(row?.updatedAt).toBeTypeOf("number");
	});

	test("cancels the previous work and overwrites the row when scheduling again for the same user", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValueOnce("work_schedule_old" as never)
			.mockResolvedValueOnce("work_schedule_new" as never);

		await t.action(internal.billing.schedule_polar_subscription_period_end_cancellation, {
			userId,
			subscriptionId: "sub_schedule_old",
		});
		await t.action(internal.billing.schedule_polar_subscription_period_end_cancellation, {
			userId,
			subscriptionId: "sub_schedule_new",
		});

		const row = await get_cancel_polar_subscription_job(t, userId);
		const rowCount = await t.run((ctx) =>
			ctx.db
				.query("billing_cancel_polar_subscription_jobs")
				.withIndex("by_userId", (q) => q.eq("userId", userId))
				.collect()
				.then((rows) => rows.length),
		);

		expect(enqueueActionSpy).toHaveBeenCalledTimes(2);
		expect(cancelSpy).toHaveBeenCalledTimes(1);
		expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), "work_schedule_old");
		expect(rowCount).toBe(1);
		expect(row?.jobId).toBe("work_schedule_new");
	});

	test("cancels and deletes the row when the scheduler is cleared explicitly", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_schedule_delete" as never);
		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);

		await t.action(internal.billing.schedule_polar_subscription_period_end_cancellation, {
			userId,
			subscriptionId: "sub_schedule_delete",
		});
		await t.action(internal.billing.cancel_scheduled_polar_subscription_period_end_cancellation, {
			userId,
		});

		const row = await get_cancel_polar_subscription_job(t, userId);

		expect(cancelSpy).toHaveBeenCalledTimes(1);
		expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), "work_schedule_delete");
		expect(row).toBeNull();
	});

	test("clears the matching row when the work completes successfully", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId,
			jobId: "work_complete_success",
			updatedAt: 12_345,
		});

		await t.mutation(internal.billing.complete_polar_subscription_period_end_cancellation, {
			workId: "work_complete_success",
			context: {
				userId,
			},
			result: {
				kind: "success",
				returnValue: null,
			},
		});

		const row = await get_cancel_polar_subscription_job(t, userId);

		expect(row).toBeNull();
	});

	test("keeps the row when the work fails", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId,
			jobId: "work_complete_failed",
			updatedAt: 22_345,
		});

		await t.mutation(internal.billing.complete_polar_subscription_period_end_cancellation, {
			workId: "work_complete_failed",
			context: {
				userId,
			},
			result: {
				kind: "failed",
				error: "polar down",
			},
		});

		const row = await get_cancel_polar_subscription_job(t, userId);

		expect(row?.jobId).toBe("work_complete_failed");
	});

	test("ignores completion from an older replaced job", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId,
			jobId: "work_complete_new",
			updatedAt: 32_345,
		});

		await t.mutation(internal.billing.complete_polar_subscription_period_end_cancellation, {
			workId: "work_complete_old",
			context: {
				userId,
			},
			result: {
				kind: "canceled",
			},
		});

		const row = await get_cancel_polar_subscription_job(t, userId);

		expect(row?.jobId).toBe("work_complete_new");
	});
});

describe("billing cancel_polar_subscription_at_period_end", () => {
	beforeEach(() => {
		subscriptionsUpdateMock.mockReset();
	});

	afterEach(() => {
		subscriptionsUpdateMock.mockReset();
	});

	test("cancels the captured subscription id without requiring a local subscription mirror", async () => {
		subscriptionsUpdateMock.mockResolvedValue({
			ok: true,
			value: {
				id: "sub_billing_cancel_period_end",
			} as never,
		});

		const t = test_convex();
		const userId = await seed_user_id(t);

		const result = await t.action(internal.billing.cancel_polar_subscription_at_period_end, {
			userId,
			subscriptionId: "sub_billing_cancel_period_end",
		});

		expect(result).toBeNull();
		expect(subscriptionsUpdateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_billing_cancel_period_end",
			subscriptionUpdate: {
				cancelAtPeriodEnd: true,
			},
		});
	});

	test("treats an already canceled subscription as success", async () => {
		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new AlreadyCanceledSubscription(
				{
					error: "AlreadyCanceledSubscription",
					detail: "Subscription already canceled",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_billing_cancel_period_end_already_canceled"),
					response: new Response(JSON.stringify({ error: "AlreadyCanceledSubscription" }), { status: 403 }),
					body: JSON.stringify({ error: "AlreadyCanceledSubscription" }),
				},
			),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);

		const result = await t.action(internal.billing.cancel_polar_subscription_at_period_end, {
			userId,
			subscriptionId: "sub_billing_cancel_period_end_already_canceled",
		});

		expect(result).toBeNull();
	});

	test("treats a missing subscription as success", async () => {
		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new ResourceNotFound(
				{
					error: "ResourceNotFound",
					detail: "Subscription not found",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_billing_cancel_period_end_missing"),
					response: new Response(JSON.stringify({ error: "ResourceNotFound" }), { status: 404 }),
					body: JSON.stringify({ error: "ResourceNotFound" }),
				},
			),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);

		const result = await t.action(internal.billing.cancel_polar_subscription_at_period_end, {
			userId,
			subscriptionId: "sub_billing_cancel_period_end_missing",
		});

		expect(result).toBeNull();
	});

	test("throws when Polar returns an unexpected cancel-at-period-end error", async () => {
		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new UnexpectedClientError("polar cancel-at-period-end exploded"),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);

		await expect(
			t.action(internal.billing.cancel_polar_subscription_at_period_end, {
				userId,
				subscriptionId: "sub_billing_cancel_period_end_error",
			}),
		).rejects.toThrow("Failed to cancel Polar subscription at period end");
	});
});

describe("ingest_events", () => {
	beforeEach(() => {
		eventsIngestMock.mockReset();
	});

	afterEach(() => {
		eventsIngestMock.mockReset();
	});

	test("skips direct Polar calls in test env", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await t.action(internal.billing.ingest_events, {
			events: [
				{
					name: "manual_credit",
					externalCustomerId: userId,
					externalId: "manual_credit::u::123",
					metadata: {
						amount: -2500,
					},
				},
			],
		});

		expect(eventsIngestMock).not.toHaveBeenCalled();
	});
});

describe("grant_monthly_credits", () => {
	beforeEach(() => {
		eventsIngestMock.mockReset();
	});

	afterEach(() => {
		eventsIngestMock.mockReset();
	});

	test("enqueues a stable monthly_credit event through the ingest workpool", async () => {
		const captured: {
			ingestPayload: {
				events: Array<{
					externalId: string;
					externalCustomerId: string;
					metadata: { amount: number; periodStart: string };
					name: string;
				}>;
			} | null;
		} = { ingestPayload: null };
		const enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async function (
			this: Workpool,
			_ctx,
			_functionReference,
			args,
		) {
			expect(this.options.defaultRetryBehavior).toEqual({
				initialBackoffMs: 10 * 60 * 1000,
				base: 1.2,
				maxAttempts: Number.POSITIVE_INFINITY,
			});

			captured.ingestPayload = args as NonNullable<typeof captured.ingestPayload>;
			return "work_monthly_credit_inserted" as never;
		});

		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_action_inserted_product",
		});

		const result = await t.action(internal.billing.grant_monthly_credits, {
			userId,
			subscriptionId: "sub_grant_action_inserted",
			productId: polarProductId,
			periodStart: "2026-01-01T00:00:00.000Z",
		});

		expect(result).toBeNull();
		expect(eventsIngestMock).not.toHaveBeenCalled();
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		const ingestPayload = captured.ingestPayload;
		if (!ingestPayload) {
			throw new Error("Expected monthly credit ingest payload to be captured");
		}
		expect(ingestPayload.events).toHaveLength(1);
		expect(ingestPayload.events[0]!.externalId).toBe(
			`monthly_credit::${userId}::sub_grant_action_inserted::2026-01-01T00:00:00.000Z`,
		);
		expect(ingestPayload.events[0]!.externalCustomerId).toBe(userId);
		expect(ingestPayload.events[0]!.metadata).toMatchObject({
			amount: -billing_PRODUCTS["Pay As You Go"].recurringCreditsCents,
			periodStart: "2026-01-01T00:00:00.000Z",
		});
		expect(ingestPayload.events[0]!.name).toBe("monthly_credit");
	});

	test("queues repeated grants and leaves duplicate handling to the ingest worker", async () => {
		const enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => {
			return "work_monthly_credit_duplicate" as never;
		});

		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_action_duplicate_product",
		});

		const result = await t.action(internal.billing.grant_monthly_credits, {
			userId,
			subscriptionId: "sub_grant_action_duplicate",
			productId: polarProductId,
			periodStart: "2026-01-01T00:00:00.000Z",
		});

		expect(result).toBeNull();
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect(eventsIngestMock).not.toHaveBeenCalled();
	});
});

describe("grant_credit", () => {
	beforeEach(() => {
		eventsIngestMock.mockReset();
	});

	afterEach(() => {
		eventsIngestMock.mockReset();
	});

	test("enqueues the canonical manual_credit event through the ingest workpool", async () => {
		vi.spyOn(Date, "now").mockReturnValue(123_456);
		const captured: {
			ingestPayload: {
				events: Array<{
					externalId: string;
					externalCustomerId: string;
					metadata: { amount: number };
					name: string;
				}>;
			} | null;
		} = { ingestPayload: null };
		const enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async (
			_ctx,
			_functionReference,
			args,
		) => {
			captured.ingestPayload = args as NonNullable<typeof captured.ingestPayload>;
			return "work_manual_credit" as never;
		});

		const t = test_convex();
		const userId = await seed_user_id(t);

		const result = await t.action(internal.billing.grant_credit, {
			userId,
			amount: 2500,
		});

		expect(result).toBeNull();
		expect(eventsIngestMock).not.toHaveBeenCalled();
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		const ingestPayload = captured.ingestPayload;
		if (!ingestPayload) {
			throw new Error("Expected manual credit ingest payload to be captured");
		}
		expect(ingestPayload.events).toHaveLength(1);
		expect(ingestPayload.events[0]!.externalId).toBe(`manual_credit::${userId}::123456`);
		expect(ingestPayload.events[0]!.externalCustomerId).toBe(userId);
		expect(ingestPayload.events[0]!.metadata).toEqual({
			amount: -2500,
		});
		expect(ingestPayload.events[0]!.name).toBe("manual_credit");
	});
});

describe("monthly credits engine via handle_polar_customer_state_update", () => {
	async function seed_usage_snapshot(
		t: ReturnType<typeof test_convex>,
		args: {
			userId: Id<"users">;
			polarCustomerId: string;
			subscription: {
				id: string;
				productId: string;
				currency: string;
				currentPeriodStart: string;
				currentPeriodEnd: string;
			} | null;
		},
	) {
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_snapshots", {
				userId: args.userId,
				polarCustomerId: args.polarCustomerId,
				subscription: args.subscription,
				meter: args.subscription
					? {
							id: "meter_units",
							consumedUnits: 0,
							creditedUnits: 0,
							balance: 0,
							amountDueCents: 0,
						}
					: null,
				lastSyncedAt: Date.now(),
			});
		});
	}

	function payg_active_subscription(args: {
		subscriptionId: string;
		productId: string;
		currentPeriodStart: string;
		currentPeriodEnd: string;
	}) {
		return {
			id: args.subscriptionId,
			product_id: args.productId,
			currency: "eur",
			current_period_start: args.currentPeriodStart,
			current_period_end: args.currentPeriodEnd,
			meters: [
				{
					meter_id: "meter_units",
					consumed_units: 0,
					credited_units: 0,
					amount: 0,
				},
			],
		};
	}

	function active_meter() {
		return {
			meter_id: "meter_units",
			consumed_units: 0,
			credited_units: 0,
			balance: 0,
		};
	}

	test("enqueues a monthly credit for the first period of an active subscription", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_first_period_product",
		});

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_grant_first_period" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-01-01T00:00:00.000Z",
				data: {
					id: "cust_grant_first_period",
					external_id: userId,
					active_subscriptions: [
						payg_active_subscription({
							subscriptionId: "sub_grant_first_period",
							productId: polarProductId,
							currentPeriodStart: "2026-01-01T00:00:00.000Z",
							currentPeriodEnd: "2026-02-01T00:00:00.000Z",
						}),
					],
					active_meters: [active_meter()],
				},
			},
		});

		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.grant_monthly_credits, {
			userId,
			subscriptionId: "sub_grant_first_period",
			productId: polarProductId,
			periodStart: "2026-01-01T00:00:00.000Z",
		});
	});

	test("re-enqueues the same monthly credit for repeated same-period webhook deliveries", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_same_period_product",
		});

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_grant_same_period" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-01-15T00:00:00.000Z",
				data: {
					id: "cust_grant_same_period",
					external_id: userId,
					active_subscriptions: [
						payg_active_subscription({
							subscriptionId: "sub_grant_same_period",
							productId: polarProductId,
							currentPeriodStart: "2026-01-01T00:00:00.000Z",
							currentPeriodEnd: "2026-02-01T00:00:00.000Z",
						}),
					],
					active_meters: [active_meter()],
				},
			},
		});
		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-01-15T00:00:01.000Z",
				data: {
					id: "cust_grant_same_period",
					external_id: userId,
					active_subscriptions: [
						payg_active_subscription({
							subscriptionId: "sub_grant_same_period",
							productId: polarProductId,
							currentPeriodStart: "2026-01-01T00:00:00.000Z",
							currentPeriodEnd: "2026-02-01T00:00:00.000Z",
						}),
					],
					active_meters: [active_meter()],
				},
			},
		});

		expect(enqueueActionSpy).toHaveBeenCalledTimes(2);
		expect(enqueueActionSpy).toHaveBeenNthCalledWith(1, expect.anything(), internal.billing.grant_monthly_credits, {
			userId,
			subscriptionId: "sub_grant_same_period",
			productId: polarProductId,
			periodStart: "2026-01-01T00:00:00.000Z",
		});
		expect(enqueueActionSpy).toHaveBeenNthCalledWith(2, expect.anything(), internal.billing.grant_monthly_credits, {
			userId,
			subscriptionId: "sub_grant_same_period",
			productId: polarProductId,
			periodStart: "2026-01-01T00:00:00.000Z",
		});
	});

	test("enqueues a monthly credit when the subscription has rolled into a new period", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_advanced_period_product",
		});
		await seed_usage_snapshot(t, {
			userId,
			polarCustomerId: "cust_grant_advanced_period",
			subscription: {
				id: "sub_grant_advanced_period",
				productId: polarProductId,
				currency: "eur",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
			},
		});

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_grant_advanced_period" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-02-01T00:00:00.000Z",
				data: {
					id: "cust_grant_advanced_period",
					external_id: userId,
					active_subscriptions: [
						payg_active_subscription({
							subscriptionId: "sub_grant_advanced_period",
							productId: polarProductId,
							currentPeriodStart: "2026-02-01T00:00:00.000Z",
							currentPeriodEnd: "2026-03-01T00:00:00.000Z",
						}),
					],
					active_meters: [active_meter()],
				},
			},
		});

		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.grant_monthly_credits, {
			userId,
			subscriptionId: "sub_grant_advanced_period",
			productId: polarProductId,
			periodStart: "2026-02-01T00:00:00.000Z",
		});
	});

	test("enqueues a monthly credit when the webhook moves the snapshot to a new subscription mid-period after a plan upgrade", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId: oldProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_upgrade_old_product",
		});
		const { polarProductId: newProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_upgrade_new_product",
		});
		await seed_usage_snapshot(t, {
			userId,
			polarCustomerId: "cust_grant_upgrade",
			subscription: {
				id: "sub_grant_upgrade_old",
				productId: oldProductId,
				currency: "eur",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
			},
		});

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_grant_upgrade" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-01-15T00:00:00.000Z",
				data: {
					id: "cust_grant_upgrade",
					external_id: userId,
					active_subscriptions: [
						payg_active_subscription({
							subscriptionId: "sub_grant_upgrade_new",
							productId: newProductId,
							currentPeriodStart: "2026-01-15T00:00:00.000Z",
							currentPeriodEnd: "2026-02-15T00:00:00.000Z",
						}),
					],
					active_meters: [active_meter()],
				},
			},
		});

		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.grant_monthly_credits, {
			userId,
			subscriptionId: "sub_grant_upgrade_new",
			productId: newProductId,
			periodStart: "2026-01-15T00:00:00.000Z",
		});
	});

	test("is a no-op when the webhook reports no active subscription", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_grant_no_subscription" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-01-01T00:00:00.000Z",
				data: {
					id: "cust_grant_no_subscription",
					external_id: userId,
					active_subscriptions: [],
					active_meters: [],
				},
			},
		});

		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});
});
