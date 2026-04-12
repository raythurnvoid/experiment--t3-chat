import type { UnionToIntersection } from "type-fest";

/** Keep human-readable billing copy in code and look up products by their exact Polar names. */
export const billing_PRODUCTS = {
	Pro: {
		name: "Pro",
		displayName: "Pro",
		meter: {
			name: "Press app usage",
			displayName: "Press app usage",
			unitPrice: {
				amount: 0.01,
				currency: "eur",
			},
		},
		benefits: {
			"Pro Included Usage": {
				description: "Pro Included Usage",
				displaySuffixText: "usage per month",
			},
		},
	},
	"Pay As You Go": {
		name: "Pay As You Go",
		displayName: "Pay As You Go",
		meter: {
			name: "Press app usage",
			displayName: "Press app usage",
			unitPrice: {
				amount: 0.01,
				currency: "eur",
			},
		},
		benefits: {
			"Free Usage": {
				description: "Free Usage",
				displaySuffixText: "usage",
			},
		},
	},
} as const;

const billing_plan_order = ["Pay As You Go", "Pro"] as const;

export function billing_get_product_benefit_display_suffix_text(productName: string, benefitDescription: string) {
	const product = billing_PRODUCTS[productName as keyof typeof billing_PRODUCTS];
	type BillingProductBenefits = UnionToIntersection<NonNullable<typeof product>["benefits"]>;
	const benefits = product?.benefits as BillingProductBenefits | undefined;
	return benefits?.[benefitDescription as keyof BillingProductBenefits]?.displaySuffixText ?? null;
}

export function billing_get_product_display_name(productName: string) {
	return billing_PRODUCTS[productName as keyof typeof billing_PRODUCTS]?.displayName ?? productName;
}

export function billing_get_plan_change_kind(currentProductName: string, targetProductName: string) {
	const currentProduct = billing_PRODUCTS[currentProductName as keyof typeof billing_PRODUCTS] ?? null;
	const targetProduct = billing_PRODUCTS[targetProductName as keyof typeof billing_PRODUCTS] ?? null;
	const currentProductOrder = billing_plan_order.indexOf(currentProductName as (typeof billing_plan_order)[number]);
	const targetProductOrder = billing_plan_order.indexOf(targetProductName as (typeof billing_plan_order)[number]);

	if (
		!currentProduct ||
		!targetProduct ||
		currentProductOrder === -1 ||
		targetProductOrder === -1 ||
		currentProductOrder === targetProductOrder
	) {
		return null;
	}

	return currentProductOrder < targetProductOrder ? ("upgrade" as const) : ("downgrade" as const);
}
