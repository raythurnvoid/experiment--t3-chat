/** Polar meter / usage event names configured for this app (Polar dashboard + ingest). */
export const BILLING_EVENTS = {
	testUnit: "billing-test-unit",
} as const;

/** Polar product `name` suffix after env prefix and hyphen (`${POLAR_PRODUCTS_PREFIX}-…`). */
export const PRODUCTS = {
	PAY_AS_YOU_GO: "billing-product-pay-as-you-go",
} as const;
