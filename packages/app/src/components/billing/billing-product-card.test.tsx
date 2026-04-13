import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";

import { BillingProductCard } from "./billing-product-card.tsx";

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

describe("BillingProductCard", () => {
	afterEach(() => {
		cleanup();
	});

	test("renders the Free product variant", () => {
		render(<BillingProductCard product={createFreeProduct()} />);

		// Title shows "Free", price shows included usage text (no duplicate "Free")
		expect(screen.getByText("Free")).not.toBeNull();
		expect(screen.getByText(/Includes .*usage per month/)).not.toBeNull();
	});
});
