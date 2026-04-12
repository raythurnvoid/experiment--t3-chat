import { billing_PRODUCTS } from "../../shared/billing.ts";

export function billing_get_product_benefit_display_suffix_text(product: string, benefit: string): string | null {
	return (billing_PRODUCTS as any)[product]?.benefits?.[benefit]?.displaySuffixText;
}

export function billing_get_product_display_name(product: string): string {
	return (billing_PRODUCTS as any)[product]?.displayName ?? product;
}
