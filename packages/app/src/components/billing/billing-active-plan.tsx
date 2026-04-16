import "./billing-active-plan.css";

import { memo, type ReactNode } from "react";
import type { LiteralUnion } from "type-fest";

import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { MyBadge } from "@/components/my-badge.tsx";
import { format_time } from "@/lib/date.ts";
import { cn, should_never_happen } from "@/lib/utils.ts";
import { format_cents, type Currency } from "../../lib/currency.ts";
import {
	billing_get_product_benefit_display_suffix_text,
	billing_get_product_display_name,
} from "../../../shared/billing.ts";

// #region skeleton
type BillingActivePlanSkeleton_ClassNames =
	| "BillingActivePlanSkeleton"
	| "BillingActivePlanSkeleton-badge"
	| "BillingActivePlanSkeleton-title"
	| "BillingActivePlanSkeleton-usage"
	| "BillingActivePlanSkeleton-renewal"
	| "BillingActivePlanSkeleton-started"
	| "BillingActivePlanSkeleton-details"
	| "BillingActivePlanSkeleton-covers"
	| "BillingActivePlanSkeleton-list"
	| "BillingActivePlanSkeleton-list-item";

export const BillingActivePlanSkeleton = memo(function BillingActivePlanSkeleton() {
	return (
		<div
			className={"BillingActivePlanSkeleton" satisfies BillingActivePlanSkeleton_ClassNames}
			aria-busy="true"
			aria-label="Loading active plan"
		>
			<div className={"BillingActivePlanSkeleton-badge" satisfies BillingActivePlanSkeleton_ClassNames} aria-hidden />
			<div className={"BillingActivePlanSkeleton-title" satisfies BillingActivePlanSkeleton_ClassNames} aria-hidden />
			<div className={"BillingActivePlanSkeleton-usage" satisfies BillingActivePlanSkeleton_ClassNames} aria-hidden />
			<div className={"BillingActivePlanSkeleton-renewal" satisfies BillingActivePlanSkeleton_ClassNames} aria-hidden />
			<div className={"BillingActivePlanSkeleton-started" satisfies BillingActivePlanSkeleton_ClassNames} aria-hidden />
			<div className={"BillingActivePlanSkeleton-details" satisfies BillingActivePlanSkeleton_ClassNames} aria-hidden>
				<div className={"BillingActivePlanSkeleton-covers" satisfies BillingActivePlanSkeleton_ClassNames} />
				<ul className={"BillingActivePlanSkeleton-list" satisfies BillingActivePlanSkeleton_ClassNames}>
					<li className={"BillingActivePlanSkeleton-list-item" satisfies BillingActivePlanSkeleton_ClassNames} />
					<li className={"BillingActivePlanSkeleton-list-item" satisfies BillingActivePlanSkeleton_ClassNames} />
					<li className={"BillingActivePlanSkeleton-list-item" satisfies BillingActivePlanSkeleton_ClassNames} />
				</ul>
			</div>
		</div>
	);
});
// #endregion skeleton

// #region plan usage
type BillingActivePlanUsage_ClassNames =
	| "BillingActivePlanUsage"
	| "BillingActivePlanUsage-line"
	| "BillingActivePlanUsage-sep"
	| "BillingActivePlanUsage-label"
	| "BillingActivePlanUsage-value"
	| "BillingActivePlanUsage-meta";

type BillingActivePlanUsage_Props = {
	due: string;
	creditsLeft: string;
};

const BillingActivePlanUsage = memo(function BillingActivePlanUsage(props: BillingActivePlanUsage_Props) {
	const { due, creditsLeft } = props;

	return (
		<div className={"BillingActivePlanUsage" satisfies BillingActivePlanUsage_ClassNames}>
			<p className={"BillingActivePlanUsage-line" satisfies BillingActivePlanUsage_ClassNames}>
				<span className={"BillingActivePlanUsage-label" satisfies BillingActivePlanUsage_ClassNames}>Due</span>{" "}
				<span className={"BillingActivePlanUsage-value" satisfies BillingActivePlanUsage_ClassNames}>{due}</span>
				<span className={"BillingActivePlanUsage-sep" satisfies BillingActivePlanUsage_ClassNames}> | </span>
				<span className={"BillingActivePlanUsage-label" satisfies BillingActivePlanUsage_ClassNames}>
					Remaining credits
				</span>{" "}
				<span className={"BillingActivePlanUsage-value" satisfies BillingActivePlanUsage_ClassNames}>
					{creditsLeft}
				</span>
			</p>
		</div>
	);
});
// #endregion plan usage

// #region active plan badge
type BillingActivePlanBadge_ClassNames =
	| "BillingActivePlanBadge"
	| "BillingActivePlanBadge-variant-active"
	| "BillingActivePlanBadge-variant-trialing"
	| "BillingActivePlanBadge-variant-ending";

type BillingActivePlanBadge_Props = {
	variant: "active" | "trialing" | "ending";
	children: ReactNode;
};

const BillingActivePlanBadge = memo(function BillingActivePlanBadge(props: BillingActivePlanBadge_Props) {
	const { variant, children } = props;

	return (
		<MyBadge
			variant="outline"
			className={cn(
				"BillingActivePlanBadge" satisfies BillingActivePlanBadge_ClassNames,
				variant === "active" && ("BillingActivePlanBadge-variant-active" satisfies BillingActivePlanBadge_ClassNames),
				variant === "trialing" &&
					("BillingActivePlanBadge-variant-trialing" satisfies BillingActivePlanBadge_ClassNames),
				variant === "ending" && ("BillingActivePlanBadge-variant-ending" satisfies BillingActivePlanBadge_ClassNames),
			)}
		>
			{children}
		</MyBadge>
	);
});
// #endregion active plan badge

// #region root
type ProductDoc = app_convex_FunctionReturnType<typeof app_convex_api.billing.list_products>[number];
type SubscriptionDoc = NonNullable<
	app_convex_FunctionReturnType<typeof app_convex_api.billing.get_current_user_subscription>
>;
type UsageSnapshotDoc = app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>;

function plan_interval_label(interval: string) {
	switch (interval) {
		case "month":
			return "monthly";
		case "year":
			return "yearly";
		default:
			throw should_never_happen("Unhandled plan interval", { interval });
	}
}

function included_usage_text(product: ProductDoc, currency: LiteralUnion<Currency, string>) {
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

function product_price_currency(product: ProductDoc) {
	const price = product.prices?.find((priceDoc) => !priceDoc.isArchived) ?? null;
	return price?.priceCurrency ?? null;
}

function get_subscription_badge_data(subscription: SubscriptionDoc) {
	if (subscription.status === "trialing") {
		return {
			badgeVariant: "trialing" as const satisfies BillingActivePlanBadge_Props["variant"],
			badgeLabel: "In trial",
		};
	}

	if (subscription.cancelAtPeriodEnd) {
		return {
			badgeVariant: "ending" as const satisfies BillingActivePlanBadge_Props["variant"],
			badgeLabel: "Subscription cancelled",
		};
	}

	return {
		badgeVariant: "active" as const satisfies BillingActivePlanBadge_Props["variant"],
		badgeLabel: "Active plan",
	};
}

function get_subscription_times_texts(subscription: SubscriptionDoc) {
	if (subscription.status === "trialing") {
		return {
			primaryLine: subscription.currentPeriodEnd
				? `Trial ends on ${format_time(Date.parse(subscription.currentPeriodEnd))}`
				: null,

			secondaryLine: subscription.startedAt ? `Started ${format_time(Date.parse(subscription.startedAt))}` : null,
		};
	}

	if (subscription.cancelAtPeriodEnd) {
		const endsAt = subscription.endsAt ?? subscription.currentPeriodEnd;
		return {
			primaryLine: endsAt ? `Subscription ends on ${format_time(Date.parse(endsAt))}` : null,

			secondaryLine: subscription.canceledAt
				? `Canceled on ${format_time(Date.parse(subscription.canceledAt))}`
				: subscription.startedAt
					? `Started ${format_time(Date.parse(subscription.startedAt))}`
					: null,
		};
	}

	return {
		primaryLine: subscription.currentPeriodEnd
			? `Renews on ${format_time(Date.parse(subscription.currentPeriodEnd))}`
			: null,

		secondaryLine: subscription.startedAt ? `Started ${format_time(Date.parse(subscription.startedAt))}` : null,
	};
}

function get_pending_update_text(subscription: SubscriptionDoc, scheduledChangeProductName: string | null | undefined) {
	if (subscription.cancelAtPeriodEnd || !subscription.pendingUpdate?.appliesAt) {
		return null;
	}

	const targetPlanText = scheduledChangeProductName ? ` to ${scheduledChangeProductName}` : "";
	return `Changes${targetPlanText} on ${format_time(Date.parse(subscription.pendingUpdate.appliesAt))}`;
}

type BillingActivePlan_ClassNames =
	| "BillingActivePlan"
	| "BillingActivePlan-title"
	| "BillingActivePlan-renewal"
	| "BillingActivePlan-pending-update"
	| "BillingActivePlan-started"
	| "BillingActivePlan-details"
	| "BillingActivePlan-list"
	| "BillingActivePlan-list-item";

export type BillingActivePlan_Props = {
	product: ProductDoc;
	subscription: SubscriptionDoc;
	usage: UsageSnapshotDoc | undefined;
	scheduledChangeProductName?: string | null;
};

export const BillingActivePlan = memo(function BillingActivePlan(props: BillingActivePlan_Props) {
	const { product, subscription, usage, scheduledChangeProductName } = props;

	const recurringPrice =
		product.prices?.find((priceDoc) => !priceDoc.isArchived && priceDoc.amountType === "fixed") ??
		product.prices?.find((priceDoc) => !priceDoc.isArchived) ??
		product.prices?.[0];

	const meteredPrice =
		product.prices?.find((priceDoc) => !priceDoc.isArchived && priceDoc.amountType === "metered_unit") ?? null;

	const usageCurrency = meteredPrice?.priceCurrency ?? product_price_currency(product);
	const includedUsageText = usageCurrency != null ? included_usage_text(product, usageCurrency) : null;

	const intervalLabel = plan_interval_label(recurringPrice?.recurringInterval ?? product.recurringInterval ?? "month");

	const badgeData = get_subscription_badge_data(subscription);
	const subscriptionTimesTexts = get_subscription_times_texts(subscription);
	const pendingUpdateText = get_pending_update_text(subscription, scheduledChangeProductName);
	const title = billing_get_product_display_name(product.name);

	const shouldShowUsage = meteredPrice != null || product.name === "Free";
	const meteredUsageSnapshot = shouldShowUsage
		? ((/* iife */) => {
				if (
					!usage?.subscription ||
					!usage.meter ||
					usage.subscription.id !== subscription.id ||
					usage.subscription.productId !== subscription.productId
				) {
					throw should_never_happen("Missing usage snapshot for active billing plan", {
						productId: product.id,
						productName: product.name,
						subscriptionId: subscription.id,
						usage,
					});
				}

				return {
					due: format_cents(usage.meter.amountDueCents, usage.subscription.currency),
					creditsLeft: format_cents(usage.meter.balance, usage.subscription.currency),
				};
			})()
		: null;

	return (
		<div className={"BillingActivePlan" satisfies BillingActivePlan_ClassNames}>
			<BillingActivePlanBadge variant={badgeData.badgeVariant}>{badgeData.badgeLabel}</BillingActivePlanBadge>
			<div className={"BillingActivePlan-title" satisfies BillingActivePlan_ClassNames}>{title}</div>
			{meteredUsageSnapshot ? (
				<BillingActivePlanUsage due={meteredUsageSnapshot.due} creditsLeft={meteredUsageSnapshot.creditsLeft} />
			) : null}
			{pendingUpdateText ? (
				<p className={"BillingActivePlan-pending-update" satisfies BillingActivePlan_ClassNames}>{pendingUpdateText}</p>
			) : subscriptionTimesTexts.primaryLine ? (
				<p className={"BillingActivePlan-renewal" satisfies BillingActivePlan_ClassNames}>
					{subscriptionTimesTexts.primaryLine}
				</p>
			) : null}
			{subscriptionTimesTexts.secondaryLine ? (
				<p className={"BillingActivePlan-started" satisfies BillingActivePlan_ClassNames}>
					{subscriptionTimesTexts.secondaryLine}
				</p>
			) : null}
			<div className={"BillingActivePlan-details" satisfies BillingActivePlan_ClassNames}>
				<ul className={"BillingActivePlan-list" satisfies BillingActivePlan_ClassNames}>
					{includedUsageText ? (
						<li className={"BillingActivePlan-list-item" satisfies BillingActivePlan_ClassNames}>
							{includedUsageText}
						</li>
					) : null}
					<li className={"BillingActivePlan-list-item" satisfies BillingActivePlan_ClassNames}>
						Billed {intervalLabel}
					</li>
				</ul>
			</div>
		</div>
	);
});
// #endregion root
