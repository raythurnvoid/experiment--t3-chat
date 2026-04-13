import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";

const { actionMock, mockQueryResults } = vi.hoisted(() => {
	return {
		actionMock: vi.fn(),
		mockQueryResults: [] as unknown[],
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
		useQuery: () => {
			return mockQueryResults.shift();
		},
	};
});

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
	} as app_convex_FunctionReturnType<typeof app_convex_api.billing.list_subscriptions>[number];
}

describe("BillingAccountManagementPanel", () => {
	beforeEach(() => {
		actionMock.mockReset();
		mockQueryResults.length = 0;
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		mockQueryResults.length = 0;
	});

	test("keeps checkout buttons when there is no active subscription", () => {
		mockQueryResults.push(
			[
				createProduct("Pro", "prod_pro"),
				createProduct("Free", "prod_free"),
				createProduct("Pay As You Go", "prod_payg"),
			],
			[],
			null,
		);

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
		mockQueryResults.push(
			[
				createProduct("Pay As You Go", "prod_payg"),
				createProduct("Pro", "prod_pro"),
				createProduct("Free", "prod_free"),
			],
			[
				createSubscription({
					id: "sub_payg",
					productId: "prod_payg",
				}),
			],
			null,
		);

		render(<BillingAccountManagementPanel isAnonymous={false} />);

		expect(screen.getByText("Other plans")).not.toBeNull();
		expect(screen.getByRole("button", { name: "change:prod_pro:Upgrade" })).not.toBeNull();
		expect(screen.getByRole("button", { name: "change:prod_free:Downgrade at renewal" })).not.toBeNull();
		expect(screen.queryByRole("button", { name: "checkout:prod_pro:none" })).toBeNull();
	});

	test("shows checkout upgrades with the active Free subscription id", () => {
		mockQueryResults.push(
			[
				createProduct("Pay As You Go", "prod_payg"),
				createProduct("Free", "prod_free"),
				createProduct("Pro", "prod_pro"),
			],
			[
				createSubscription({
					id: "sub_free",
					productId: "prod_free",
				}),
			],
			null,
		);

		render(<BillingAccountManagementPanel isAnonymous={false} />);

		expect(screen.getByRole("button", { name: "checkout:prod_payg:sub_free" })).not.toBeNull();
		expect(screen.getByRole("button", { name: "checkout:prod_pro:sub_free" })).not.toBeNull();
		expect(screen.queryByText("change:prod_payg:Upgrade")).toBeNull();
	});

	test("shows scheduled downgrade messaging when a lower-tier change is pending", () => {
		mockQueryResults.push(
			[
				createProduct("Free", "prod_free"),
				createProduct("Pay As You Go", "prod_payg"),
				createProduct("Pro", "prod_pro"),
			],
			[
				createSubscription({
					id: "sub_pro",
					productId: "prod_pro",
					pendingUpdate: {
						id: "pending_payg",
						appliesAt: "2026-02-01T00:00:00.000Z",
						productId: "prod_payg",
						seats: null,
					},
				}),
			],
			null,
		);

		render(<BillingAccountManagementPanel isAnonymous={false} />);

		expect(screen.getByText(/It changes to Pay As You Go on/)).not.toBeNull();
		expect(screen.getByText("Scheduled:Pay As You Go")).not.toBeNull();
		expect(screen.getByRole("button", { name: "change:prod_payg:Downgrade at renewal" })).not.toBeNull();
	});
});
