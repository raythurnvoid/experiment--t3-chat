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
				recurringInterval: "month",
			},
		],
		benefits: [],
	} as unknown as app_convex_FunctionReturnType<typeof app_convex_api.billing.list_products>[number];
}

function createPayAsYouGoProduct() {
	return {
		id: "prod_payg",
		name: "Pay As You Go",
		isArchived: false,
		recurringInterval: "month",
		prices: [
			{
				id: "price_payg",
				amountType: "metered_unit",
				isArchived: false,
				productId: "prod_payg",
				priceCurrency: "eur",
				recurringInterval: "month",
			},
		],
	} as app_convex_FunctionReturnType<typeof app_convex_api.billing.list_products>[number];
}

function createSubscription(args?: { productId?: string }) {
	return {
		id: "sub_free",
		productId: args?.productId ?? "prod_free",
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

	test("renders Free with the customer-meter balance and zero amount due", () => {
		render(
			<BillingActivePlan
				product={createFreeProduct()}
				subscription={createSubscription()}
				usageSnapshot={
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
							consumedUnits: 240,
							creditedUnits: 1000,
							balance: 760,
							amountDueCents: 0,
						},
						lastSyncedAt: Date.parse("2026-01-15T00:00:00.000Z"),
					} as app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>
				}
			/>,
		);

		expect(screen.getByText("Due")).not.toBeNull();
		expect(screen.getByText("€0.00")).not.toBeNull();
		expect(screen.getByText("Remaining credits")).not.toBeNull();
		expect(screen.getByText("€7.60")).not.toBeNull();
		expect(screen.getByText("Includes €10.00 of usage per month")).not.toBeNull();
	});

	test("hides the usage line for Free when the customer meter is not yet available", () => {
		render(
			<BillingActivePlan
				product={createFreeProduct()}
				subscription={createSubscription()}
				usageSnapshot={
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
						meter: null,
						lastSyncedAt: Date.parse("2026-01-15T00:00:00.000Z"),
					} as app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>
				}
			/>,
		);

		expect(screen.queryByText("Due")).toBeNull();
		expect(screen.queryByText("Remaining credits")).toBeNull();
		expect(screen.getByText("Includes €10.00 of usage per month")).not.toBeNull();
	});

	test("throws when a metered active plan is missing a matching usage snapshot", () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => {
			render(
				<BillingActivePlan
					product={createPayAsYouGoProduct()}
					subscription={createSubscription({ productId: "prod_payg" })}
					usageSnapshot={null}
				/>,
			);
		}).toThrow("Missing usage snapshot for active billing plan");

		consoleErrorSpy.mockRestore();
	});

	test("throws when a metered active plan only has a synthetic null-id usage snapshot", () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => {
			render(
				<BillingActivePlan
					product={createPayAsYouGoProduct()}
					subscription={createSubscription({ productId: "prod_payg" })}
					usageSnapshot={
						{
							userId: "user_payg",
							polarCustomerId: null,
							subscription: {
								id: null,
								productId: "prod_payg",
								currency: "eur",
								currentPeriodStart: "2026-01-01T00:00:00.000Z",
								currentPeriodEnd: "2026-02-01T00:00:00.000Z",
							},
							meter: {
								id: null,
								consumedUnits: 240,
								creditedUnits: 1000,
								balance: 760,
								amountDueCents: 0,
							},
							lastSyncedAt: Date.parse("2026-01-15T00:00:00.000Z"),
						} as app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>
					}
				/>,
			);
		}).toThrow("Missing usage snapshot for active billing plan");

		consoleErrorSpy.mockRestore();
	});
});
