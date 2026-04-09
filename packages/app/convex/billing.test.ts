import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import type { CustomerState } from "@polar-sh/sdk/models/components/customerstate.js";
import { BILLING_EVENTS, PRODUCTS } from "../shared/billing.ts";
import {
	billing_enqueue_page_save_event,
	billing_usage_snapshot_fields_from_customer_state,
	BILLING_USAGE_SNAPSHOT_STALE_AFTER_MS,
} from "./billing.ts";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with, test_mocks } from "./setup.test.ts";
import { customersGetState } from "@polar-sh/sdk/funcs/customersGetState.js";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { pages_FIRST_VERSION, pages_ROOT_ID } from "../server/pages.ts";
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
			userId: "user_mapper_test",
			polarCustomerId: state.id,
			now,
			reason: "unit_test",
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
		expect(fields.lastRefreshReason).toBe("unit_test");
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
			userId: "u1",
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
			userId: "user_dup",
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
		expect(configured.setup).toBe("ready");
		if (configured.setup !== "ready") {
			throw new Error("Expected ready setup");
		}
		expect(configured.payAsYouGo.id).toBe(polarProductId);
		expect(configured.payAsYouGo.name).toBe(polarProductName);
	});

	test("returns product_not_in_catalog when no product name matches", async () => {
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

		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim()!;
		const expectedName = `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;

		const configured = await asUser.query(internal.billing.get_pay_as_you_go_product, {});
		expect(configured.setup).toBe("product_not_in_catalog");
		if (configured.setup !== "product_not_in_catalog") {
			throw new Error("Expected product_not_in_catalog");
		}
		expect(configured.expectedProductName).toBe(expectedName);
	});

	test("returns duplicate_product_name when more than one active product uses the checkout name", async () => {
		const t = test_convex();
		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim();
		if (!prefix) {
			throw new Error("Expected POLAR_PRODUCTS_PREFIX from setup-env.test.ts");
		}
		const polarProductName = `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;

		for (const id of ["billing_dup_a", "billing_dup_b"] as const) {
			await t.mutation(components.polar.lib.createProduct, {
				product: {
					id,
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
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_dup" as Id<"users">,
			name: "Billing Dup",
			email: "billing-dup@test.local",
		});

		const configured = await asUser.query(internal.billing.get_pay_as_you_go_product, {});
		expect(configured.setup).toBe("duplicate_product_name");
		if (configured.setup !== "duplicate_product_name") {
			throw new Error("Expected duplicate_product_name");
		}
		expect(configured.expectedProductName).toBe(polarProductName);
	});
});

describe("billing get_billing_overview", () => {
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
				description: args.description ?? "A flexible pay-as-you-go plan with metered billing and included credits.",
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

	test("returns anonymous access when unauthenticated", async () => {
		const t = test_convex();

		const overview = await t.query(api.billing.get_billing_overview, {});

		expect(overview).toEqual({ access: "anonymous" });
	});

	test("returns anonymous access for anonymous JWT users", async () => {
		const t = test_convex();
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: "user_billing_overview_anonymous" as Id<"users">,
			name: "Overview Anonymous",
		});

		const overview = await asAnonymous.query(api.billing.get_billing_overview, {});

		expect(overview).toEqual({ access: "anonymous" });
	});

	test("returns anonymous access when Clerk external_id is not set yet", async () => {
		const t = test_convex();
		const asSignedInWithoutExternalId = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-without-external-id",
			name: "Overview No External Id",
			email: "overview-no-external-id@test.local",
		});

		const overview = await asSignedInWithoutExternalId.query(api.billing.get_billing_overview, {});

		expect(overview).toEqual({ access: "anonymous" });
	});

	test("returns none + showCheckout when user has no Polar customer row", async () => {
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

		const overview = await asUser.query(api.billing.get_billing_overview, {});
		expect(overview.access).toBe("signed_in");
		if (overview.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(overview.catalog.setup).toBe("ready");
		expect(overview.subscription.state).toBe("none");
		expect(overview.showCheckout).toBe(true);
		expect(overview.planDetails?.productId).toBe(polarProductId);
		expect(overview.planDetails?.description).toBe(
			"A flexible plan for teams that want to pay only for what they use.",
		);
		expect(overview.planDetails?.unitAmount).toBe(5);
		expect(overview.planDetails?.meterName).toBe("Billable units");
		expect(overview.planDetails?.benefitDescriptions).toEqual([]);
		expect(overview.usage.state).toBe("unavailable");
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
					description: "Included",
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

		const overview = await asUser.query(api.billing.get_billing_overview, {});
		expect(overview.access).toBe("signed_in");
		if (overview.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(overview.planDetails?.includedMeterCreditsUnits).toBe(250);
		expect(overview.planDetails?.hasMeterCreditBenefit).toBe(true);
		expect(overview.planDetails?.benefitDescriptions).toContain("Included");
		expect(overview.usage.state).toBe("unavailable");
	});

	test("returns active subscription state and hides checkout", async () => {
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

		const overview = await asUser.query(api.billing.get_billing_overview, {});
		expect(overview.access).toBe("signed_in");
		if (overview.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(overview.subscription.state).toBe("active");
		if (overview.subscription.state !== "active") {
			throw new Error("Expected active");
		}
		expect(overview.subscription.polarStatus).toBe("active");
		expect(overview.subscription.startedAt).toBe("2026-01-01T00:00:00.000Z");
		expect(overview.showCheckout).toBe(false);
		expect(overview.usage.state).toBe("loading");
	});

	test("returns cancel_at_period_end when cancelAtPeriodEnd is true", async () => {
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

		const overview = await asUser.query(api.billing.get_billing_overview, {});
		expect(overview.access).toBe("signed_in");
		if (overview.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(overview.subscription.state).toBe("cancel_at_period_end");
		expect(overview.showCheckout).toBe(false);
		expect(overview.usage.state).toBe("loading");
	});

	test("returns trialing when Polar status is trialing", async () => {
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

		const overview = await asUser.query(api.billing.get_billing_overview, {});
		expect(overview.access).toBe("signed_in");
		if (overview.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(overview.subscription.state).toBe("trialing");
		expect(overview.showCheckout).toBe(false);
		expect(overview.usage.state).toBe("loading");
	});

	test("returns usage error when sync failure row exists and snapshot is absent", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_usage_err",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_usage_err",
			userId: "user_billing_overview_usage_err",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_overview_usage_err",
				customerId: "cust_overview_usage_err",
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

		const failedAt = 1_700_000_000_000;
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_sync_failures", {
				userId: "user_billing_overview_usage_err",
				message: "Polar unreachable (test)",
				at: failedAt,
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_usage_err" as Id<"users">,
			name: "Overview Usage Err",
			email: "overview-usage-err@test.local",
		});

		const overview = await asUser.query(api.billing.get_billing_overview, {});
		expect(overview.access).toBe("signed_in");
		if (overview.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(overview.usage.state).toBe("error");
		if (overview.usage.state !== "error") {
			throw new Error("Expected error usage");
		}
		expect(overview.usage.message).toContain("Polar unreachable");
		expect(overview.usage.at).toBe(failedAt);
	});

	test("returns loading after clear_usage_sync_failure when snapshot is still absent", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_usage_recover",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_usage_recover",
			userId: "user_billing_overview_usage_recover",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_overview_usage_recover",
				customerId: "cust_overview_usage_recover",
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

		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_sync_failures", {
				userId: "user_billing_overview_usage_recover",
				message: "Stale transient failure",
				at: Date.now(),
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_usage_recover" as Id<"users">,
			name: "Overview Usage Recover",
			email: "overview-usage-recover@test.local",
		});

		const before = await asUser.query(api.billing.get_billing_overview, {});
		expect(before.access).toBe("signed_in");
		if (before.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(before.usage.state).toBe("error");

		await t.mutation(internal.billing.clear_usage_sync_failure, {
			userId: "user_billing_overview_usage_recover",
		});

		const after = await asUser.query(api.billing.get_billing_overview, {});
		expect(after.access).toBe("signed_in");
		if (after.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(after.usage.state).toBe("loading");
	});

	test("returns ambiguous when two active PAYG subscriptions exist", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_ambiguous",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_ambiguous",
			userId: "user_billing_overview_ambiguous",
		});

		for (const id of ["sub_overview_a", "sub_overview_b"] as const) {
			await t.mutation(components.polar.lib.createSubscription, {
				subscription: {
					id,
					customerId: "cust_overview_ambiguous",
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
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_ambiguous" as Id<"users">,
			name: "Overview Ambiguous",
			email: "overview-ambiguous@test.local",
		});

		const overview = await asUser.query(api.billing.get_billing_overview, {});
		expect(overview.access).toBe("signed_in");
		if (overview.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(overview.subscription.state).toBe("ambiguous");
		expect(overview.showCheckout).toBe(false);
		expect(overview.usage.state).toBe("unavailable");
	});

	test("returns ready usage when a billing_usage_snapshots row exists", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_usage_ready",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_usage_ready",
			userId: "user_billing_overview_usage_ready",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_overview_usage_ready",
				customerId: "cust_overview_usage_ready",
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
				userId: "user_billing_overview_usage_ready",
				polarCustomerId: "cust_overview_usage_ready",
				subscriptionId: "sub_overview_usage_ready",
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
			external_id: "user_billing_overview_usage_ready" as Id<"users">,
			name: "Overview Usage",
			email: "overview-usage@test.local",
		});

		const overview = await asUser.query(api.billing.get_billing_overview, {});
		expect(overview.access).toBe("signed_in");
		if (overview.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(overview.usage.state).toBe("ready");
		if (overview.usage.state !== "ready") {
			throw new Error("Expected ready usage");
		}
		expect(overview.usage.consumedUnits).toBe(4);
		expect(overview.usage.amountDueCents).toBe(250);
		expect(overview.usage.balance).toBe(96);
		expect(overview.usage.lastSyncedAt).toBe(syncedAt);
	});

	test("returns stale usage when the snapshot is older than the stale window", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_usage_stale",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_usage_stale",
			userId: "user_billing_overview_usage_stale",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_overview_usage_stale",
				customerId: "cust_overview_usage_stale",
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

		const oldSync = Date.now() - BILLING_USAGE_SNAPSHOT_STALE_AFTER_MS - 1;
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_snapshots", {
				userId: "user_billing_overview_usage_stale",
				polarCustomerId: "cust_overview_usage_stale",
				subscriptionId: "sub_overview_usage_stale",
				productId: polarProductId,
				meterId: "meter_units",
				meterName: null,
				consumedUnits: 1,
				creditedUnits: 2,
				balance: 1,
				amountDueCents: 0,
				currency: "usd",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				lastSyncedAt: oldSync,
				lastError: null,
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_usage_stale" as Id<"users">,
			name: "Overview Stale",
			email: "overview-stale-usage@test.local",
		});

		const overview = await asUser.query(api.billing.get_billing_overview, {});
		expect(overview.access).toBe("signed_in");
		if (overview.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(overview.usage.state).toBe("stale");
	});

	test("hides checkout when catalog is misconfigured", async () => {
		const t = test_convex();

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_misconfigured" as Id<"users">,
			name: "Overview Misconfigured",
			email: "overview-misconfigured@test.local",
		});

		const overview = await asUser.query(api.billing.get_billing_overview, {});
		expect(overview.access).toBe("signed_in");
		if (overview.access !== "signed_in") {
			throw new Error("Expected signed_in");
		}
		expect(overview.catalog.setup).toBe("product_not_in_catalog");
		expect(overview.planDetails).toBeNull();
		expect(overview.showCheckout).toBe(false);
		expect(overview.usage.state).toBe("unavailable");
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
			userId: "user_refresh_snapshot",
		});

		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_sync_failures", {
				userId: "user_refresh_snapshot",
				message: "previous transient error",
				at: now - 1,
			});
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

		await t.action(internal.billing.refresh_usage_snapshot, {
			userId: "user_refresh_snapshot",
			reason: "unit_test",
		});

		const snapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_userId", (q) => q.eq("userId", "user_refresh_snapshot"))
				.unique(),
		);
		expect(snapshot).not.toBeNull();
		expect(snapshot!.polarCustomerId).toBe("cust_refresh_snapshot");
		expect(snapshot!.amountDueCents).toBe(700);
		expect(snapshot!.balance).toBe(1993);
		expect(snapshot!.lastError).toBeNull();

		const failure = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_sync_failures")
				.withIndex("by_userId", (q) => q.eq("userId", "user_refresh_snapshot"))
				.unique(),
		);
		expect(failure).toBeNull();
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

describe("billing changeCurrentSubscription", () => {
	test("rejects plan changes", async () => {
		const t = test_convex();
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_no_plan_change" as Id<"users">,
			name: "No Plan Change",
			email: "no-plan-change@test.local",
		});

		await expect(asUser.action(api.billing.changeCurrentSubscription, { productId: "any_product" })).rejects.toThrow(
			"Plan changes are not supported",
		);
	});
});

describe("billing_enqueue_page_save_event", () => {
	afterEach(() => {
		eventsIngestMock.mockReset();
	});

	test("inserts polar_usage_events_outbox and dedupes by key", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const pageId = await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				createdBy: membership.userId,
				updatedBy: String(membership.userId),
				name: "polar-usage-page",
				path: "/polar-usage-page",
				parentId: pages_ROOT_ID,
				version: pages_FIRST_VERSION,
				archiveOperationId: undefined,
			});

			return { ...membership, pageId };
		});

		const now = 1_700_000_000_000;
		const newSequence = 7;
		await t.run(async (ctx) => {
			await billing_enqueue_page_save_event(ctx, {
				userId: seeded.userId,
				pageId: seeded.pageId,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				newSequence,
				now,
			});
			await billing_enqueue_page_save_event(ctx, {
				userId: seeded.userId,
				pageId: seeded.pageId,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				newSequence,
				now,
			});
		});

		const eventName = BILLING_EVENTS.testUnit;
		const dedupeKey = `${eventName}:${seeded.userId}:${seeded.pageId}:${newSequence}`;

		const rows = await t.run(async (ctx) => ctx.db.query("polar_usage_events_outbox").collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.dedupeKey).toBe(dedupeKey);
		expect(rows[0]!.externalCustomerId).toBe(seeded.userId);
		expect(rows[0]!.eventName).toBe(eventName);
		expect(rows[0]!.status).toBe("pending");
		expect(rows[0]!.metadata).toMatchObject({
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: String(seeded.pageId),
			yjsSequence: String(newSequence),
			source: "page-save",
		});
	});
});

describe("drain_outbox", () => {
	beforeEach(() => {
		eventsIngestMock.mockReset();
	});

	afterEach(() => {
		eventsIngestMock.mockReset();
	});

	test("deletes rows when eventsIngest succeeds", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		const rowId = await t.run(async (ctx) => {
			const createdAt = 1_700_000_000_001;
			return await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: `${BILLING_EVENTS.testUnit}:u:test-page:1`,
				externalCustomerId: "user_drain_ok",
				eventName: BILLING_EVENTS.testUnit,
				status: "pending",
				createdAt,
				metadata: {
					source: "page-save",
					workspaceId: "ws",
					projectId: "pr",
					pageId: "page",
					yjsSequence: "1",
				},
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const rowAfter = await t.run(async (ctx) => ctx.db.get("polar_usage_events_outbox", rowId));
		expect(rowAfter).toBeNull();
		expect(eventsIngestMock).toHaveBeenCalledTimes(1);
		const ingestCall = eventsIngestMock.mock.calls[0];
		expect(ingestCall).toBeDefined();
		const ingestPayload = ingestCall![1] as {
			events: Array<{ externalId: string; externalCustomerId: string; name: string }>;
		};
		expect(ingestPayload.events).toHaveLength(1);
		expect(ingestPayload.events[0]!.externalId).toBe(`${BILLING_EVENTS.testUnit}:u:test-page:1`);
		expect(ingestPayload.events[0]!.externalCustomerId).toBe("user_drain_ok");
		expect("customerId" in ingestPayload.events[0]! && ingestPayload.events[0]!.customerId).toBeFalsy();
		expect(ingestPayload.events[0]!.name).toBe(BILLING_EVENTS.testUnit);
	});

	test("sends customerId when polar customer mapping exists", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		await t.mutation(components.polar.lib.insertCustomer, {
			id: "polar_cust_drain_mapped",
			userId: "user_drain_mapped",
		});

		const rowId = await t.run(async (ctx) => {
			return await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: `${BILLING_EVENTS.testUnit}:u:test-page:mapped`,
				externalCustomerId: "user_drain_mapped",
				eventName: BILLING_EVENTS.testUnit,
				status: "pending",
				createdAt: 1_700_000_000_050,
				metadata: { source: "page-save" },
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const rowAfter = await t.run(async (ctx) => ctx.db.get("polar_usage_events_outbox", rowId));
		expect(rowAfter).toBeNull();
		const ingestCall = eventsIngestMock.mock.calls[0];
		expect(ingestCall).toBeDefined();
		const ingestPayload = ingestCall![1] as {
			events: Array<{ name: string; externalId?: string; externalCustomerId?: string; customerId?: string }>;
		};
		expect(ingestPayload.events).toHaveLength(1);
		expect(ingestPayload.events[0]!.name).toBe(BILLING_EVENTS.testUnit);
		expect(ingestPayload.events[0]!.customerId).toBe("polar_cust_drain_mapped");
		expect(ingestPayload.events[0]!.externalId).toBe(`${BILLING_EVENTS.testUnit}:u:test-page:mapped`);
		expect(ingestPayload.events[0]!.externalCustomerId).toBeUndefined();
	});

	test("marks row failed when eventsIngest returns an error result", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: false,
			error: { statusCode: 400, message: "ingest_failed_test" } as never,
		});

		const t = test_convex();
		const rowId = await t.run(async (ctx) => {
			return await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: `${BILLING_EVENTS.testUnit}:u:test-page:2`,
				externalCustomerId: "user_drain_fail",
				eventName: BILLING_EVENTS.testUnit,
				status: "pending",
				createdAt: 1_700_000_000_002,
				metadata: {},
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const rowAfter = await t.run(async (ctx) => ctx.db.get("polar_usage_events_outbox", rowId));
		expect(rowAfter).not.toBeNull();
		expect(rowAfter!.status).toBe("failed");
		expect(rowAfter!.lastError).toContain("ingest_failed_test");
	});

	test("marks row failed when eventsIngest throws", async () => {
		eventsIngestMock.mockRejectedValue(new Error("ingest_threw_test"));

		const t = test_convex();
		const rowId = await t.run(async (ctx) => {
			return await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: `${BILLING_EVENTS.testUnit}:u:test-page:throw`,
				externalCustomerId: "user_drain_throw",
				eventName: BILLING_EVENTS.testUnit,
				status: "pending",
				createdAt: 1_700_000_000_003,
				metadata: {},
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const rowAfter = await t.run(async (ctx) => ctx.db.get("polar_usage_events_outbox", rowId));
		expect(rowAfter).not.toBeNull();
		expect(rowAfter!.status).toBe("failed");
		expect(rowAfter!.lastError).toContain("ingest_threw_test");
	});

	test("processes rows oldest-first", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		await t.run(async (ctx) => {
			await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: `${BILLING_EVENTS.testUnit}:u:test-page:older`,
				externalCustomerId: "user_older",
				eventName: BILLING_EVENTS.testUnit,
				status: "pending",
				createdAt: 1_700_000_000_010,
			});
			await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: `${BILLING_EVENTS.testUnit}:u:test-page:newer`,
				externalCustomerId: "user_newer",
				eventName: BILLING_EVENTS.testUnit,
				status: "pending",
				createdAt: 1_700_000_000_011,
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const firstPayload = eventsIngestMock.mock.calls[0]![1] as {
			events: Array<{ externalId: string }>;
		};
		const secondPayload = eventsIngestMock.mock.calls[1]![1] as {
			events: Array<{ externalId: string }>;
		};
		expect(firstPayload.events[0]!.externalId).toBe(`${BILLING_EVENTS.testUnit}:u:test-page:older`);
		expect(secondPayload.events[0]!.externalId).toBe(`${BILLING_EVENTS.testUnit}:u:test-page:newer`);
	});

	test("respects the drain batch size", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		await t.run(async (ctx) => {
			for (let i = 0; i < 25; i++) {
				await ctx.db.insert("polar_usage_events_outbox", {
					dedupeKey: `${BILLING_EVENTS.testUnit}:u:test-page:batch:${i}`,
					externalCustomerId: `user_batch_${i}`,
					eventName: BILLING_EVENTS.testUnit,
					status: "pending",
					createdAt: 1_700_000_001_000 + i,
				});
			}
		});

		await t.action(internal.billing.drain_outbox, {});

		const rowsAfter = await t.run(async (ctx) =>
			ctx.db
				.query("polar_usage_events_outbox")
				.withIndex("by_status_createdAt", (q) => q.eq("status", "pending"))
				.collect(),
		);
		expect(eventsIngestMock).toHaveBeenCalledTimes(24);
		expect(rowsAfter).toHaveLength(1);
		expect(rowsAfter[0]!.dedupeKey).toBe(`${BILLING_EVENTS.testUnit}:u:test-page:batch:24`);
	});

	test("ignores already failed rows", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		const failedRowId = await t.run(async (ctx) => {
			await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: `${BILLING_EVENTS.testUnit}:u:test-page:failed`,
				externalCustomerId: "user_failed",
				eventName: BILLING_EVENTS.testUnit,
				status: "failed",
				createdAt: 1_700_000_002_000,
				lastError: "previous failure",
			});
			return await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: `${BILLING_EVENTS.testUnit}:u:test-page:pending`,
				externalCustomerId: "user_pending",
				eventName: BILLING_EVENTS.testUnit,
				status: "pending",
				createdAt: 1_700_000_002_001,
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const remainingRows = await t.run(async (ctx) => ctx.db.query("polar_usage_events_outbox").collect());
		expect(eventsIngestMock).toHaveBeenCalledTimes(1);
		expect(remainingRows).toHaveLength(1);
		expect(remainingRows[0]!.status).toBe("failed");
		expect(remainingRows[0]!._id).not.toBe(failedRowId);
	});
});

describe("refresh_usage_snapshot catalog guard", () => {
	test("clears usage sync failure when pay-as-you-go catalog is not ready", async () => {
		const t = test_convex();
		const userId = "user_refresh_catalog_not_ready";
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_sync_failures", {
				userId,
				message: "previous polar error",
				at: Date.now(),
			});
		});

		await t.action(internal.billing.refresh_usage_snapshot, {
			userId,
			reason: "unit_test_catalog",
		});

		const failure = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_sync_failures")
				.withIndex("by_userId", (q) => q.eq("userId", userId))
				.unique(),
		);
		expect(failure).toBeNull();
	});
});
