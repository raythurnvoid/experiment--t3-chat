import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";

const { actionMock, useQueryMock } = vi.hoisted(() => {
	return {
		actionMock: vi.fn(),
		useQueryMock: vi.fn(),
	};
});

type MockButton_Props = ComponentProps<"button">;

vi.mock("convex/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("convex/react")>();

	return {
		...actual,
		useConvex: () => ({
			action: actionMock,
		}),
		useQuery: (query: unknown) => useQueryMock(query),
	};
});

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T extends (...args: never[]) => unknown>(handler: T) => handler,
}));

vi.mock("@/components/billing/billing-active-plan.tsx", () => ({
	BillingActivePlan: function BillingActivePlan(props: { scheduledChangeProductName?: string | null }) {
		return <div>{props.scheduledChangeProductName ? `Scheduled:${props.scheduledChangeProductName}` : "Active plan"}</div>;
	},
	BillingActivePlanSkeleton: function BillingActivePlanSkeleton() {
		return <div>Loading active plan</div>;
	},
}));

vi.mock("@/components/billing/billing-checkout-button.tsx", () => ({
	BillingCheckoutButton: function BillingCheckoutButton(props: { productId: string; subscriptionId?: string }) {
		return <button type="button">{`checkout:${props.productId}:${props.subscriptionId ?? "none"}`}</button>;
	},
}));

vi.mock("@/components/billing/billing-change-plan-button.tsx", () => ({
	BillingChangePlanButton: function BillingChangePlanButton(props: {
		productId: string;
		children: ReactNode;
	}) {
		return <button type="button">{`change:${props.productId}:${props.children}`}</button>;
	},
}));

vi.mock("@/components/billing/billing-product-card.tsx", () => ({
	BillingProductCard: function BillingProductCard(props: {
		product: { name: string };
		selectPlanSlot?: ReactNode;
	}) {
		return (
			<div>
				<div>{props.product.name}</div>
				{props.selectPlanSlot}
			</div>
		);
	},
	BillingProductCardSkeleton: function BillingProductCardSkeleton() {
		return <div>Loading product</div>;
	},
}));

vi.mock("@/components/my-button.tsx", () => ({
	MyButton: function MyButton(props: MockButton_Props) {
		return <button {...props} />;
	},
}));

import { BillingAccountManagementPanel } from "./billing-account-management-panel.tsx";

function createProduct(name: string, id: string) {
	return {
		id,
		name,
		isArchived: false,
	} as app_convex_FunctionReturnType<typeof app_convex_api.billing.list_products>[number];
}

function createSubscription(args: {
	id: string;
	productId: string;
	pendingUpdate?: {
		id: string;
		appliesAt: string;
		productId: string | null;
		seats: number | null;
	} | null;
}) {
	return {
		id: args.id,
		productId: args.productId,
		status: "active",
		endedAt: null,
		cancelAtPeriodEnd: false,
		currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		startedAt: "2026-01-01T00:00:00.000Z",
		pendingUpdate: args.pendingUpdate ?? null,
	} as NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.billing.get_current_user_subscription>>;
}

function createUsageSnapshot(args: { subscriptionId: string; productId: string }) {
	return {
		userId: "user_free",
		polarCustomerId: "cust_free",
		subscription: {
			id: args.subscriptionId,
			productId: args.productId,
			currency: "eur",
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		},
		meter: {
			id: "meter_press_usage",
			consumedUnits: 100,
			creditedUnits: 1000,
			balance: 900,
			amountDueCents: 0,
		},
		lastSyncedAt: Date.parse("2026-01-15T00:00:00.000Z"),
	} as NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>>;
}

function mockBillingQueries(args: {
	products: app_convex_FunctionReturnType<typeof app_convex_api.billing.list_products>;
	subscription: app_convex_FunctionReturnType<typeof app_convex_api.billing.get_current_user_subscription>;
	billingUsageSnapshot: app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>;
}) {
	const queryResults = [args.products, args.subscription, args.billingUsageSnapshot];
	let callIndex = 0;
	useQueryMock.mockImplementation(() => {
		const result = queryResults[callIndex % queryResults.length];
		callIndex += 1;
		return result;
	});
}

describe("BillingAccountManagementPanel", () => {
	beforeEach(() => {
		actionMock.mockReset();
		useQueryMock.mockReset();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("keeps checkout buttons when there is no active subscription", () => {
		mockBillingQueries({
			products: [
				createProduct("Pro", "prod_pro"),
				createProduct("Free", "prod_free"),
				createProduct("Pay As You Go", "prod_payg"),
			],
			subscription: null,
			billingUsageSnapshot: null,
		});

		render(<BillingAccountManagementPanel isAnonymous={false} />);

		expect(screen.getByText("Available plans")).not.toBeNull();
		expect(screen.getByRole("button", { name: "checkout:prod_free:none" })).not.toBeNull();
		expect(screen.getByRole("button", { name: "checkout:prod_payg:none" })).not.toBeNull();
		expect(screen.getByRole("button", { name: "checkout:prod_pro:none" })).not.toBeNull();
		expect(screen.getAllByText(/^(Free|Pay As You Go|Pro)$/).map((element) => element.textContent)).toEqual([
			"Free",
			"Pay As You Go",
			"Pro",
		]);
	});

	test("shows an upgrade action for higher-ranked plans when the user already has a subscription", () => {
		mockBillingQueries({
			products: [
				createProduct("Pay As You Go", "prod_payg"),
				createProduct("Pro", "prod_pro"),
				createProduct("Free", "prod_free"),
			],
			subscription: createSubscription({
				id: "sub_payg",
				productId: "prod_payg",
			}),
			billingUsageSnapshot: createUsageSnapshot({
				subscriptionId: "sub_payg",
				productId: "prod_payg",
			}),
		});

		render(<BillingAccountManagementPanel isAnonymous={false} />);

		expect(screen.getByText("Other plans")).not.toBeNull();
		expect(screen.getByRole("button", { name: "change:prod_pro:Upgrade" })).not.toBeNull();
		expect(screen.getByRole("button", { name: "change:prod_free:Downgrade at renewal" })).not.toBeNull();
		expect(screen.queryByRole("button", { name: "checkout:prod_pro:none" })).toBeNull();
	});

	test("shows checkout upgrades with the active Free subscription id", () => {
		mockBillingQueries({
			products: [
				createProduct("Pay As You Go", "prod_payg"),
				createProduct("Free", "prod_free"),
				createProduct("Pro", "prod_pro"),
			],
			subscription: createSubscription({
				id: "sub_free",
				productId: "prod_free",
			}),
			billingUsageSnapshot: createUsageSnapshot({
				subscriptionId: "sub_free",
				productId: "prod_free",
			}),
		});

		render(<BillingAccountManagementPanel isAnonymous={false} />);

		expect(screen.getByRole("button", { name: "checkout:prod_payg:sub_free" })).not.toBeNull();
		expect(screen.getByRole("button", { name: "checkout:prod_pro:sub_free" })).not.toBeNull();
		expect(screen.queryByText("change:prod_payg:Upgrade")).toBeNull();
	});

	test("renders the active plan section even when the usage snapshot is still missing", () => {
		mockBillingQueries({
			products: [
				createProduct("Free", "prod_free"),
				createProduct("Pay As You Go", "prod_payg"),
				createProduct("Pro", "prod_pro"),
			],
			subscription: createSubscription({
				id: "sub_free",
				productId: "prod_free",
			}),
			billingUsageSnapshot: null,
		});

		render(<BillingAccountManagementPanel isAnonymous={false} />);

		expect(screen.getByText("Active plan")).not.toBeNull();
		expect(screen.queryByText("Loading your billing details...")).toBeNull();
	});

	test("shows scheduled downgrade messaging when a lower-tier change is pending", () => {
		mockBillingQueries({
			products: [
				createProduct("Free", "prod_free"),
				createProduct("Pay As You Go", "prod_payg"),
				createProduct("Pro", "prod_pro"),
			],
			subscription: createSubscription({
				id: "sub_pro",
				productId: "prod_pro",
				pendingUpdate: {
					id: "pending_payg",
					appliesAt: "2026-02-01T00:00:00.000Z",
					productId: "prod_payg",
					seats: null,
				},
			}),
			billingUsageSnapshot: createUsageSnapshot({
				subscriptionId: "sub_pro",
				productId: "prod_pro",
			}),
		});

		render(<BillingAccountManagementPanel isAnonymous={false} />);

		expect(screen.getByText(/It changes to Pay As You Go on/)).not.toBeNull();
		expect(screen.getByText("Scheduled:Pay As You Go")).not.toBeNull();
		expect(screen.getByRole("button", { name: "change:prod_payg:Downgrade at renewal" })).not.toBeNull();
	});
});
