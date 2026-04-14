import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";

vi.mock("@/components/my-badge.tsx", () => ({
	MyBadge: function MyBadge(props: { children: ReactNode; className?: string }) {
		return <div className={props.className}>{props.children}</div>;
	},
}));

import { BillingActivePlan } from "./billing-active-plan.tsx";

function createFreeProduct() {
	return {
		id: "prod_free",
		name: "Free",
		isArchived: false,
		recurringInterval: "month",
		prices: [
			{
				id: "price_free",
				amountType: "free",
				isArchived: false,
				productId: "prod_free",
				priceCurrency: "eur",
				recurringInterval: "month",
			},
		],
		benefits: [
			{
				id: "benefit_free",
				type: "meter_credit",
				description: "Free Included Usage",
				properties: {
					units: 1000,
				},
			},
		],
	} as app_convex_FunctionReturnType<typeof app_convex_api.billing.list_products>[number];
}

function createSubscription() {
	return {
		id: "sub_free",
		productId: "prod_free",
		status: "active",
		cancelAtPeriodEnd: false,
		currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: null,
		pendingUpdate: null,
	} as NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.billing.get_current_user_subscription>>;
}

describe("BillingActivePlan", () => {
	afterEach(() => {
		cleanup();
	});

	test("renders usage for the Free plan and keeps negative balances visible", () => {
		render(
			<BillingActivePlan
				product={createFreeProduct()}
				subscription={createSubscription()}
				usage={
					{
						userId: "user_free",
						polarCustomerId: "cust_free",
						subscription: {
							id: "sub_free",
							productId: "prod_free",
							currency: "eur",
							currentPeriodStart: "2026-01-01T00:00:00.000Z",
							currentPeriodEnd: "2026-02-01T00:00:00.000Z",
						},
						meter: {
							id: "meter_press_usage",
							consumedUnits: 1250,
							creditedUnits: 1000,
							balance: -250,
							amountDueCents: 0,
						},
						lastSyncedAt: Date.parse("2026-01-15T00:00:00.000Z"),
					} as app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>
				}
			/>,
		);

		expect(screen.getByText("Due")).not.toBeNull();
		expect(screen.getByText(/€0\.00/)).not.toBeNull();
		expect(screen.getByText(/-€2\.50|€-2\.50/)).not.toBeNull();
	});

	test("throws when the active plan is missing a matching usage snapshot", () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => {
			render(
				<BillingActivePlan
					product={createFreeProduct()}
					subscription={createSubscription()}
					usage={null}
				/>,
			);
		}).toThrow("Missing usage snapshot for active billing plan");

		consoleErrorSpy.mockRestore();
	});
});
