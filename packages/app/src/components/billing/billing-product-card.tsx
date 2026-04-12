import "./billing-product-card.css";

import { memo, type ReactNode } from "react";

import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { format_cents, type Currency } from "@/lib/currency.ts";
import type { LiteralUnion } from "type-fest";
import { should_never_happen } from "../../lib/utils.ts";
import {
	billing_get_product_benefit_display_suffix_text,
	billing_get_product_display_name,
} from "../../lib/billing.ts";
import { billing_PRODUCTS, billing_product_matches_polar_name } from "../../../shared/billing.ts";

type BillingProductCard_ProductDoc = app_convex_FunctionReturnType<typeof app_convex_api.billing.list_products>[number];

function included_usage_text(product: BillingProductCard_ProductDoc, currency: LiteralUnion<Currency, string>) {
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

function metered_price_currency(product: BillingProductCard_ProductDoc) {
	const meteredPrice =
		product.prices?.find((priceDoc) => !priceDoc.isArchived && priceDoc.amountType === "metered_unit") ?? null;
	return meteredPrice?.priceCurrency ?? null;
}

function fixed_price_text(product: BillingProductCard_ProductDoc) {
	const fixedPrice =
		product.prices?.find((priceDoc) => !priceDoc.isArchived && priceDoc.amountType === "fixed") ?? null;

	if (fixedPrice?.priceAmount == null || fixedPrice.priceCurrency == null) {
		return null;
	}

	const intervalLabel = fixedPrice.recurringInterval ?? product.recurringInterval ?? "month";
	return `${format_cents(fixedPrice.priceAmount, fixedPrice.priceCurrency)} / ${intervalLabel}`;
}

// #region skeleton
type BillingProductCardSkeleton_ClassNames =
	| "BillingProductCardSkeleton"
	| "BillingProductCardSkeleton-title"
	| "BillingProductCardSkeleton-price"
	| "BillingProductCardSkeleton-secondary"
	| "BillingProductCardSkeleton-included"
	| "BillingProductCardSkeleton-list"
	| "BillingProductCardSkeleton-list-item";

export const BillingProductCardSkeleton = memo(function BillingProductCardSkeleton() {
	return (
		<div
			className={"BillingProductCardSkeleton" satisfies BillingProductCardSkeleton_ClassNames}
			aria-busy="true"
			aria-label="Loading product"
		>
			<div className={"BillingProductCardSkeleton-title" satisfies BillingProductCardSkeleton_ClassNames} aria-hidden />
			<div className={"BillingProductCardSkeleton-price" satisfies BillingProductCardSkeleton_ClassNames} aria-hidden />
			<div
				className={"BillingProductCardSkeleton-secondary" satisfies BillingProductCardSkeleton_ClassNames}
				aria-hidden
			/>
			<div
				className={"BillingProductCardSkeleton-included" satisfies BillingProductCardSkeleton_ClassNames}
				aria-hidden
			/>
			<ul className={"BillingProductCardSkeleton-list" satisfies BillingProductCardSkeleton_ClassNames}>
				<li className={"BillingProductCardSkeleton-list-item" satisfies BillingProductCardSkeleton_ClassNames} />
				<li className={"BillingProductCardSkeleton-list-item" satisfies BillingProductCardSkeleton_ClassNames} />
			</ul>
		</div>
	);
});
// #endregion skeleton

// #region surface
type BillingProductCardSurface_ClassNames =
	| "BillingProductCardSurface"
	| "BillingProductCardSurface-title"
	| "BillingProductCardSurface-price"
	| "BillingProductCardSurface-details"
	| "BillingProductCardSurface-select-plan";

type BillingProductCardSurface_Props = {
	title: string;
	priceText: string;
	selectPlanSlot?: ReactNode;
	children?: ReactNode;
};

const BillingProductCardSurface = memo(function BillingProductCardSurface(props: BillingProductCardSurface_Props) {
	const { title, priceText, selectPlanSlot, children } = props;

	return (
		<div className={"BillingProductCardSurface" satisfies BillingProductCardSurface_ClassNames}>
			<h3 className={"BillingProductCardSurface-title" satisfies BillingProductCardSurface_ClassNames}>{title}</h3>
			<p className={"BillingProductCardSurface-price" satisfies BillingProductCardSurface_ClassNames}>{priceText}</p>
			{children ? (
				<ul className={"BillingProductCardSurface-details" satisfies BillingProductCardSurface_ClassNames}>
					{children}
				</ul>
			) : null}
			{selectPlanSlot ? (
				<div className={"BillingProductCardSurface-select-plan" satisfies BillingProductCardSurface_ClassNames}>
					{selectPlanSlot}
				</div>
			) : null}
		</div>
	);
});
// #endregion surface

// #region pay-as-you-go
type BillingProductCardPayAsYouGo_ClassNames = "BillingProductCardPayAsYouGo" | "BillingProductCardPayAsYouGo-detail";

type BillingProductCardPayAsYouGo_Props = {
	product: BillingProductCard_ProductDoc;
	selectPlanSlot?: ReactNode;
};

const BillingProductCardPayAsYouGo = memo(function BillingProductCardPayAsYouGo(
	props: BillingProductCardPayAsYouGo_Props,
) {
	const { product, selectPlanSlot } = props;

	const displayName = billing_get_product_display_name(product.name);
	const currency = metered_price_currency(product);
	const includedUsageText = currency != null ? included_usage_text(product, currency) : null;

	return (
		<BillingProductCardSurface title={displayName} priceText="Only pay for what you use" selectPlanSlot={selectPlanSlot}>
			{includedUsageText ? (
				<li className={"BillingProductCardPayAsYouGo-detail" satisfies BillingProductCardPayAsYouGo_ClassNames}>
					{includedUsageText}
				</li>
			) : null}
		</BillingProductCardSurface>
	);
});
// #endregion pay-as-you-go

// #region pro
type BillingProductCardPro_ClassNames = "BillingProductCardPro" | "BillingProductCardPro-detail";

type BillingProductCardPro_Props = {
	product: BillingProductCard_ProductDoc;
	selectPlanSlot?: ReactNode;
};

const BillingProductCardPro = memo(function BillingProductCardPro(props: BillingProductCardPro_Props) {
	const { product, selectPlanSlot } = props;

	const displayName = billing_get_product_display_name(product.name);
	const primaryPriceText = fixed_price_text(product);
	if (!primaryPriceText) {
		throw should_never_happen("Pro product missing fixed price", { product });
	}

	const currency = metered_price_currency(product);
	const includedUsageText = currency != null ? included_usage_text(product, currency) : null;

	return (
		<BillingProductCardSurface
			title={displayName}
			priceText={primaryPriceText}
			selectPlanSlot={selectPlanSlot}
		>
			{includedUsageText ? (
				<li className={"BillingProductCardPro-detail" satisfies BillingProductCardPro_ClassNames}>
					{includedUsageText}
				</li>
			) : null}
			<li className={"BillingProductCardPro-detail" satisfies BillingProductCardPro_ClassNames}>
				Extra usage is charged based on what you use
			</li>
		</BillingProductCardSurface>
	);
});
// #endregion pro

// #region root
export type BillingProductCard_Props = {
	product: BillingProductCard_ProductDoc;
	selectPlanSlot?: ReactNode;
};

export const BillingProductCard = memo(function BillingProductCard(props: BillingProductCard_Props) {
	const { product, selectPlanSlot } = props;

	const matched_product_key = (Object.keys(billing_PRODUCTS) as (keyof typeof billing_PRODUCTS)[]).find((key) =>
		billing_product_matches_polar_name(product.name, billing_PRODUCTS[key]),
	);

	switch (matched_product_key) {
		case "Pay As You Go":
			return <BillingProductCardPayAsYouGo product={product} selectPlanSlot={selectPlanSlot} />;
		case "Pro":
			return <BillingProductCardPro product={product} selectPlanSlot={selectPlanSlot} />;
		default:
			return null;
	}
});
// #endregion root
