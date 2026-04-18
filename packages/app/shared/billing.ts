/**
 * Keep human-readable billing copy in code and look up products by their exact Polar names.
 *
 * `recurringCreditsCents` is the canonical per-month credit grant for each plan.
 * The Convex monthly credits engine reads this value to ingest negative usage
 * events at every subscription period boundary; Polar `meter_credit` benefits
 * are detached from products so they never grant credits in parallel.
 *
 */
export const billing_PRODUCTS = {
	Free: {
		name: "Free",
		displayName: "Free",
		recurringCreditsCents: 1000,
	},
	Pro: {
		name: "Pro",
		displayName: "Pro",
		recurringCreditsCents: 6000,
		meter: {
			name: "Press app usage",
			displayName: "Press app usage",
		},
	},
	"Pay As You Go": {
		name: "Pay As You Go",
		displayName: "Pay As You Go",
		recurringCreditsCents: 1000,
		meter: {
			name: "Press app usage",
			displayName: "Press app usage",
		},
	},
} as const;

const billing_plan_order = ["Free", "Pay As You Go", "Pro"] as const;

export function billing_get_product_order(productName: string) {
	const productOrder = billing_plan_order.indexOf(productName as (typeof billing_plan_order)[number]);
	return productOrder === -1 ? Number.POSITIVE_INFINITY : productOrder;
}

export function billing_compare_product_order(leftProductName: string, rightProductName: string) {
	const leftOrder = billing_get_product_order(leftProductName);
	const rightOrder = billing_get_product_order(rightProductName);

	if (Number.isFinite(leftOrder) || Number.isFinite(rightOrder)) {
		return leftOrder - rightOrder;
	}

	return leftProductName.localeCompare(rightProductName);
}

export function billing_get_product_display_name(productName: string) {
	return billing_PRODUCTS[productName as keyof typeof billing_PRODUCTS]?.displayName ?? productName;
}

export function billing_get_recurring_credits_cents(productName: string) {
	return billing_PRODUCTS[productName as keyof typeof billing_PRODUCTS]?.recurringCreditsCents ?? 0;
}

export function billing_get_plan_change_kind(currentProductName: string, targetProductName: string) {
	const currentProduct = billing_PRODUCTS[currentProductName as keyof typeof billing_PRODUCTS] ?? null;
	const targetProduct = billing_PRODUCTS[targetProductName as keyof typeof billing_PRODUCTS] ?? null;
	const currentProductOrder = billing_get_product_order(currentProductName);
	const targetProductOrder = billing_get_product_order(targetProductName);

	if (
		!currentProduct ||
		!targetProduct ||
		!Number.isFinite(currentProductOrder) ||
		!Number.isFinite(targetProductOrder) ||
		currentProductOrder === targetProductOrder
	) {
		return null;
	}

	return currentProductOrder < targetProductOrder ? ("upgrade" as const) : ("downgrade" as const);
}
