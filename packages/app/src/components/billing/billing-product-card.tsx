import "./billing-product-card.css";

import { billing_PRODUCTS } from "../../../shared/billing.ts";
import { memo } from "react";

import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { format_cents, type Currency } from "@/lib/currency.ts";
import type { LiteralUnion, UnionToIntersection } from "type-fest";
import { should_never_happen } from "../../lib/utils.ts";
import { billing_get_product_benefit_display_suffix_text } from "../../lib/billing.ts";

// #region skeleton
type MainAppAccountManagementBillingProductCardSkeleton_ClassNames =
	| "MainAppAccountManagementBillingProductCardSkeleton"
	| "MainAppAccountManagementBillingProductCardSkeleton-title"
	| "MainAppAccountManagementBillingProductCardSkeleton-price"
	| "MainAppAccountManagementBillingProductCardSkeleton-secondary"
	| "MainAppAccountManagementBillingProductCardSkeleton-included"
	| "MainAppAccountManagementBillingProductCardSkeleton-list"
	| "MainAppAccountManagementBillingProductCardSkeleton-list-item";

export const MainAppAccountManagementBillingProductCardSkeleton = memo(
	function MainAppAccountManagementBillingProductCardSkeleton() {
		return (
			<div
				className={
					"MainAppAccountManagementBillingProductCardSkeleton" satisfies MainAppAccountManagementBillingProductCardSkeleton_ClassNames
				}
				aria-busy="true"
				aria-label="Loading product"
			>
				<div
					className={
						"MainAppAccountManagementBillingProductCardSkeleton-title" satisfies MainAppAccountManagementBillingProductCardSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingProductCardSkeleton-price" satisfies MainAppAccountManagementBillingProductCardSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingProductCardSkeleton-secondary" satisfies MainAppAccountManagementBillingProductCardSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingProductCardSkeleton-included" satisfies MainAppAccountManagementBillingProductCardSkeleton_ClassNames
					}
					aria-hidden
				/>
				<ul
					className={
						"MainAppAccountManagementBillingProductCardSkeleton-list" satisfies MainAppAccountManagementBillingProductCardSkeleton_ClassNames
					}
				>
					<li
						className={
							"MainAppAccountManagementBillingProductCardSkeleton-list-item" satisfies MainAppAccountManagementBillingProductCardSkeleton_ClassNames
						}
					/>
					<li
						className={
							"MainAppAccountManagementBillingProductCardSkeleton-list-item" satisfies MainAppAccountManagementBillingProductCardSkeleton_ClassNames
						}
					/>
				</ul>
			</div>
		);
	},
);
// #endregion skeleton

// #region root
type MainAppAccountManagementBillingProductCard_ProductDoc = app_convex_FunctionReturnType<
	typeof app_convex_api.billing.list_products
>[number];

function included_usage_text(
	product: MainAppAccountManagementBillingProductCard_ProductDoc,
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

type MainAppAccountManagementBillingProductCard_ClassNames =
	| "MainAppAccountManagementBillingProductCard"
	| "MainAppAccountManagementBillingProductCard-title"
	| "MainAppAccountManagementBillingProductCard-price"
	| "MainAppAccountManagementBillingProductCard-included";

export type MainAppAccountManagementBillingProductCard_Props = {
	product: MainAppAccountManagementBillingProductCard_ProductDoc;
};

export const MainAppAccountManagementBillingProductCard = memo(function MainAppAccountManagementBillingProductCard(
	props: MainAppAccountManagementBillingProductCard_Props,
) {
	const { product } = props;

	const displayName = billing_PRODUCTS[product.name as keyof typeof billing_PRODUCTS]?.displayName ?? product.name;

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
				"MainAppAccountManagementBillingProductCard" satisfies MainAppAccountManagementBillingProductCard_ClassNames
			}
		>
			<h3
				className={
					"MainAppAccountManagementBillingProductCard-title" satisfies MainAppAccountManagementBillingProductCard_ClassNames
				}
			>
				{displayName}
			</h3>
			<p
				className={
					"MainAppAccountManagementBillingProductCard-price" satisfies MainAppAccountManagementBillingProductCard_ClassNames
				}
			>
				{primaryPriceText ?? "Pricing unavailable"}
			</p>
			<p
				className={
					"MainAppAccountManagementBillingProductCard-included" satisfies MainAppAccountManagementBillingProductCard_ClassNames
				}
			>
				{includedUsageText}
			</p>
		</div>
	);
});
// #endregion root
