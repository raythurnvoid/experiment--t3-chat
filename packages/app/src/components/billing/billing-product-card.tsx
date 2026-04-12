import "./billing-product-card.css";

import { memo } from "react";

import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { format_cents, type Currency } from "@/lib/currency.ts";
import type { LiteralUnion } from "type-fest";
import { should_never_happen } from "../../lib/utils.ts";
import {
	billing_get_product_benefit_display_suffix_text,
	billing_get_product_display_name,
} from "../../lib/billing.ts";

// #region skeleton
type BillingProductCardSkeleton_ClassNames =
	| "BillingProductCardSkeleton"
	| "BillingProductCardSkeleton-title"
	| "BillingProductCardSkeleton-price"
	| "BillingProductCardSkeleton-secondary"
	| "BillingProductCardSkeleton-included"
	| "BillingProductCardSkeleton-list"
	| "BillingProductCardSkeleton-list-item";

export const BillingProductCardSkeleton = memo(
	function BillingProductCardSkeleton() {
		return (
			<div
				className={
					"BillingProductCardSkeleton" satisfies BillingProductCardSkeleton_ClassNames
				}
				aria-busy="true"
				aria-label="Loading product"
			>
				<div
					className={
						"BillingProductCardSkeleton-title" satisfies BillingProductCardSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"BillingProductCardSkeleton-price" satisfies BillingProductCardSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"BillingProductCardSkeleton-secondary" satisfies BillingProductCardSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"BillingProductCardSkeleton-included" satisfies BillingProductCardSkeleton_ClassNames
					}
					aria-hidden
				/>
				<ul
					className={
						"BillingProductCardSkeleton-list" satisfies BillingProductCardSkeleton_ClassNames
					}
				>
					<li
						className={
							"BillingProductCardSkeleton-list-item" satisfies BillingProductCardSkeleton_ClassNames
						}
					/>
					<li
						className={
							"BillingProductCardSkeleton-list-item" satisfies BillingProductCardSkeleton_ClassNames
						}
					/>
				</ul>
			</div>
		);
	},
);
// #endregion skeleton

// #region root
type BillingProductCard_ProductDoc = app_convex_FunctionReturnType<
	typeof app_convex_api.billing.list_products
>[number];

function included_usage_text(
	product: BillingProductCard_ProductDoc,
	currency: LiteralUnion<Currency, string>,
) {
	const benefit = product.benefits?.find((benefit) => {
		return benefit.type === "meter_credit";
	});

	if (!benefit) {
		return null;
	}

	const includedUsageAmount = benefit.properties?.units;
	if (!includedUsageAmount) {
		throw should_never_happen("Product benefit data missing `includedUsageAmount`", { benefit });
	}

	const suffixText = billing_get_product_benefit_display_suffix_text(product.name, benefit.description);

	if (!suffixText) {
		throw should_never_happen("Product benefit data missing `suffixText`", { benefit });
	}

	return `Includes ${format_cents(includedUsageAmount, currency)} of ${suffixText}`;
}

type BillingProductCard_ClassNames =
	| "BillingProductCard"
	| "BillingProductCard-title"
	| "BillingProductCard-price"
	| "BillingProductCard-included";

export type BillingProductCard_Props = {
	product: BillingProductCard_ProductDoc;
};

export const BillingProductCard = memo(function BillingProductCard(
	props: BillingProductCard_Props,
) {
	const { product } = props;

	const displayName = billing_get_product_display_name(product.name);

	const fixedPrice =
		product.prices?.find((priceDoc) => !priceDoc.isArchived && priceDoc.amountType === "fixed") ?? null;
	const meteredPrice =
		product.prices?.find((priceDoc) => !priceDoc.isArchived && priceDoc.amountType === "metered_unit") ?? null;

	const primaryPriceText =
		fixedPrice?.priceAmount != null && fixedPrice.priceCurrency != null
			? `${format_cents(fixedPrice.priceAmount, fixedPrice.priceCurrency)} / ${fixedPrice.recurringInterval}`
			: null;

	const includedUsageText =
		meteredPrice?.priceCurrency != null ? included_usage_text(product, meteredPrice.priceCurrency) : null;

	if (!primaryPriceText) {
		throw should_never_happen("Failed to compute product data `primaryPriceText`", { fixedPrice });
	}

	return (
		<div
			className={
				"BillingProductCard" satisfies BillingProductCard_ClassNames
			}
		>
			<h3
				className={
					"BillingProductCard-title" satisfies BillingProductCard_ClassNames
				}
			>
				{displayName}
			</h3>
			<p
				className={
					"BillingProductCard-price" satisfies BillingProductCard_ClassNames
				}
			>
				{primaryPriceText ?? "Pricing unavailable"}
			</p>
			<p
				className={
					"BillingProductCard-included" satisfies BillingProductCard_ClassNames
				}
			>
				{includedUsageText}
			</p>
		</div>
	);
});
// #endregion root
