type BillingMonetaryAmount = {
	amount: number;
	currency: "eur";
};

type BillingProductBenefit = {
	description: string;
	displayDescription: string;
	includedUsage?: BillingMonetaryAmount;
};

type BillingProductMeter = {
	name: string;
	displayName: string;
	unitPrice?: BillingMonetaryAmount;
};

type BillingProduct = {
	name: string;
	displayName: string;
	meter: BillingProductMeter;
	benefits: Record<string, BillingProductBenefit>;
};

/** Keep human-readable billing copy in code and match Polar rows by stable ids or equivalent normalized names. */
export const BILLING_PRODUCTS = {
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
			"Free usage": {
				description: "Free usage",
				displayDescription: "Free usage granted on subscription",
				includedUsage: {
					amount: 20,
					currency: "eur",
				},
			},
		},
	},
} as const satisfies Record<string, BillingProduct>;

/** Keep the canonical pay-as-you-go product name used across the app. */
export const PRODUCTS = {
	PAY_AS_YOU_GO: BILLING_PRODUCTS["Pay As You Go"].name,
} as const;

function billing_normalize_polar_identifier(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

export function billing_product_matches_polar_name(productName: string, product: BillingProduct) {
	const normalizedProductName = billing_normalize_polar_identifier(productName);
	const normalizedProductId = billing_normalize_polar_identifier(product.name);
	return (
		productName === product.name ||
		productName.endsWith(`-${product.name}`) ||
		normalizedProductName === normalizedProductId ||
		normalizedProductName.endsWith(`_${normalizedProductId}`)
	);
}

export function billing_product_benefit_matches_polar_description(
	polarBenefitDescription: string,
	benefit: BillingProductBenefit,
) {
	const normalizedBenefitDescription = billing_normalize_polar_identifier(polarBenefitDescription);
	const normalizedBenefitDescriptionId = billing_normalize_polar_identifier(benefit.description);
	return (
		polarBenefitDescription === benefit.description ||
		polarBenefitDescription.endsWith(`-${benefit.description}`) ||
		normalizedBenefitDescription === normalizedBenefitDescriptionId ||
		normalizedBenefitDescription.endsWith(`_${normalizedBenefitDescriptionId}`)
	);
}
