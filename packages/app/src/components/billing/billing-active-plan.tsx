import "./billing-active-plan.css";

import {
	billing_PRODUCTS,
	billing_product_benefit_matches_polar_description,
	billing_product_matches_polar_name,
} from "../../../shared/billing.ts";
import { memo } from "react";

import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { format_time } from "@/lib/date.ts";
import { cn } from "@/lib/utils.ts";

type MainAppAccountManagementBillingActivePlan_ProductDoc = app_convex_FunctionReturnType<
	typeof app_convex_api.billing.list_products
>[number];

type MainAppAccountManagementBillingActivePlan_SubscriptionDoc = app_convex_FunctionReturnType<
	typeof app_convex_api.billing.list_subscriptions
>[number];

type MainAppAccountManagementBillingActivePlan_UsageSnapshot = app_convex_FunctionReturnType<
	typeof app_convex_api.billing.get_usage_snapshot
>;

function billing_active_plan_interval_label(interval: string | null) {
	if (interval === "month") {
		return "monthly";
	}
	if (interval === "year") {
		return "yearly";
	}
	return interval ? String(interval) : "recurring";
}

function billing_active_plan_format_minor_currency(amountCents: number, currency: string) {
	const code = currency.trim().toUpperCase();
	if (!code) {
		return String(amountCents / 100);
	}
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: code,
	}).format(amountCents / 100);
}

function billing_active_plan_format_major_currency(amountMajor: number, currency: string) {
	const code = currency.trim().toUpperCase();
	if (!code) {
		return String(amountMajor);
	}
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: code,
	}).format(amountMajor);
}

function billing_active_plan_resolve_billing_product(catalog: MainAppAccountManagementBillingActivePlan_ProductDoc) {
	return (
		Object.values(billing_PRODUCTS).find((product) => {
			return billing_product_matches_polar_name(catalog.name, product);
		}) ?? null
	);
}

function billing_active_plan_benefit_descriptions(
	product: (typeof billing_PRODUCTS)[keyof typeof billing_PRODUCTS] | null,
	benefits: MainAppAccountManagementBillingActivePlan_ProductDoc["benefits"] | null | undefined,
) {
	if (!product) {
		return (benefits ?? [])
			.map((benefit) => benefit.description.trim())
			.filter((description) => description.length > 0);
	}

	return (benefits ?? [])
		.map((benefit) => {
			const matchingBenefit = Object.values(product.benefits).find((productBenefit) => {
				return billing_product_benefit_matches_polar_description(benefit.description, productBenefit);
			});
			if (!matchingBenefit) {
				return null;
			}

			if (matchingBenefit.description === billing_PRODUCTS["Pay As You Go"].benefits["Free usage"].description) {
				return "Free usage granted on subscription";
			}

			return matchingBenefit.description.trim();
		})
		.filter((description): description is string => description != null);
}

type MainAppAccountManagementBillingActivePlanSkeleton_ClassNames =
	| "MainAppAccountManagementBillingActivePlanSkeleton"
	| "MainAppAccountManagementBillingActivePlanSkeleton-badge"
	| "MainAppAccountManagementBillingActivePlanSkeleton-title"
	| "MainAppAccountManagementBillingActivePlanSkeleton-usage"
	| "MainAppAccountManagementBillingActivePlanSkeleton-renewal"
	| "MainAppAccountManagementBillingActivePlanSkeleton-started"
	| "MainAppAccountManagementBillingActivePlanSkeleton-details"
	| "MainAppAccountManagementBillingActivePlanSkeleton-covers"
	| "MainAppAccountManagementBillingActivePlanSkeleton-list"
	| "MainAppAccountManagementBillingActivePlanSkeleton-list-item";

export const MainAppAccountManagementBillingActivePlanSkeleton = memo(
	function MainAppAccountManagementBillingActivePlanSkeleton() {
		return (
			<div
				className={
					"MainAppAccountManagementBillingActivePlanSkeleton" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
				}
				aria-busy="true"
				aria-label="Loading active plan"
			>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-badge" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-title" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-usage" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-renewal" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-started" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-details" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				>
					<div
						className={
							"MainAppAccountManagementBillingActivePlanSkeleton-covers" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
						}
					/>
					<ul
						className={
							"MainAppAccountManagementBillingActivePlanSkeleton-list" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
						}
					>
						<li
							className={
								"MainAppAccountManagementBillingActivePlanSkeleton-list-item" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
							}
						/>
						<li
							className={
								"MainAppAccountManagementBillingActivePlanSkeleton-list-item" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
							}
						/>
						<li
							className={
								"MainAppAccountManagementBillingActivePlanSkeleton-list-item" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
							}
						/>
					</ul>
				</div>
			</div>
		);
	},
);

type MainAppAccountManagementBillingActivePlanUsage_ClassNames =
	| "MainAppAccountManagementBillingActivePlanUsage"
	| "MainAppAccountManagementBillingActivePlanUsage-line"
	| "MainAppAccountManagementBillingActivePlanUsage-sep"
	| "MainAppAccountManagementBillingActivePlanUsage-label"
	| "MainAppAccountManagementBillingActivePlanUsage-value"
	| "MainAppAccountManagementBillingActivePlanUsage-meta";

type MainAppAccountManagementBillingActivePlanUsage_MeteredLine =
	| { kind: "loading" }
	| {
			kind: "ready";
			due: string;
			creditsLeft: string;
	  };

type MainAppAccountManagementBillingActivePlanUsage_Props = {
	meteredLine: MainAppAccountManagementBillingActivePlanUsage_MeteredLine | null;
};

const MainAppAccountManagementBillingActivePlanUsage = memo(function MainAppAccountManagementBillingActivePlanUsage(
	props: MainAppAccountManagementBillingActivePlanUsage_Props,
) {
	const { meteredLine } = props;

	if (!meteredLine) {
		return null;
	}

	if (meteredLine.kind === "loading") {
		return (
			<div
				className={
					"MainAppAccountManagementBillingActivePlanUsage" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
				}
			>
				<p
					className={
						"MainAppAccountManagementBillingActivePlanUsage-meta" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					Syncing usage...
				</p>
			</div>
		);
	}

	return (
		<div
			className={
				"MainAppAccountManagementBillingActivePlanUsage" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
			}
		>
			<p
				className={
					"MainAppAccountManagementBillingActivePlanUsage-line" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
				}
			>
				<span
					className={
						"MainAppAccountManagementBillingActivePlanUsage-label" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					Due
				</span>{" "}
				<span
					className={
						"MainAppAccountManagementBillingActivePlanUsage-value" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					{meteredLine.due}
				</span>
				<span
					className={
						"MainAppAccountManagementBillingActivePlanUsage-sep" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					{" "}
					|{" "}
				</span>
				<span
					className={
						"MainAppAccountManagementBillingActivePlanUsage-label" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					Remaining credits
				</span>{" "}
				<span
					className={
						"MainAppAccountManagementBillingActivePlanUsage-value" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					{meteredLine.creditsLeft}
				</span>
			</p>
		</div>
	);
});

type MainAppAccountManagementBillingActivePlan_ClassNames =
	| "MainAppAccountManagementBillingActivePlan"
	| "MainAppAccountManagementBillingActivePlan-badge"
	| "MainAppAccountManagementBillingActivePlan-badge-active"
	| "MainAppAccountManagementBillingActivePlan-badge-trialing"
	| "MainAppAccountManagementBillingActivePlan-badge-ending"
	| "MainAppAccountManagementBillingActivePlan-title"
	| "MainAppAccountManagementBillingActivePlan-renewal"
	| "MainAppAccountManagementBillingActivePlan-started"
	| "MainAppAccountManagementBillingActivePlan-details"
	| "MainAppAccountManagementBillingActivePlan-list"
	| "MainAppAccountManagementBillingActivePlan-list-item";

type MainAppAccountManagementBillingActivePlan_StatePresentation = {
	badgeClassName:
		| "MainAppAccountManagementBillingActivePlan-badge-active"
		| "MainAppAccountManagementBillingActivePlan-badge-trialing"
		| "MainAppAccountManagementBillingActivePlan-badge-ending";
	badgeLabel: string;
	primaryLine: string | null;
	secondaryLine: string | null;
};

function billing_active_plan_state_presentation(
	subscription: MainAppAccountManagementBillingActivePlan_SubscriptionDoc,
): MainAppAccountManagementBillingActivePlan_StatePresentation {
	if (subscription.status === "trialing") {
		return {
			badgeClassName: "MainAppAccountManagementBillingActivePlan-badge-trialing",
			badgeLabel: "In trial",
			primaryLine: subscription.currentPeriodEnd
				? `Trial ends on ${format_time(Date.parse(subscription.currentPeriodEnd))}`
				: null,
			secondaryLine: subscription.startedAt ? `Started ${format_time(Date.parse(subscription.startedAt))}` : null,
		};
	}

	if (subscription.cancelAtPeriodEnd) {
		const endsAt = subscription.endsAt ?? subscription.currentPeriodEnd;
		return {
			badgeClassName: "MainAppAccountManagementBillingActivePlan-badge-ending",
			badgeLabel: "Subscription cancelled",
			primaryLine: endsAt ? `Subscription ends on ${format_time(Date.parse(endsAt))}` : null,
			secondaryLine: subscription.canceledAt
				? `Canceled on ${format_time(Date.parse(subscription.canceledAt))}`
				: subscription.startedAt
					? `Started ${format_time(Date.parse(subscription.startedAt))}`
					: null,
		};
	}

	return {
		badgeClassName: "MainAppAccountManagementBillingActivePlan-badge-active",
		badgeLabel: "Active plan",
		primaryLine: subscription.currentPeriodEnd
			? `Renews on ${format_time(Date.parse(subscription.currentPeriodEnd))}`
			: null,
		secondaryLine: subscription.startedAt ? `Started ${format_time(Date.parse(subscription.startedAt))}` : null,
	};
}

export type MainAppAccountManagementBillingActivePlan_Props = {
	catalog: MainAppAccountManagementBillingActivePlan_ProductDoc;
	subscription: MainAppAccountManagementBillingActivePlan_SubscriptionDoc;
	usage: MainAppAccountManagementBillingActivePlan_UsageSnapshot;
};

export const MainAppAccountManagementBillingActivePlan = memo(function MainAppAccountManagementBillingActivePlan(
	props: MainAppAccountManagementBillingActivePlan_Props,
) {
	const { catalog, subscription, usage } = props;
	const billingProduct = billing_active_plan_resolve_billing_product(catalog);
	const recurringPrice =
		catalog.prices?.find((priceDoc) => !priceDoc.isArchived && priceDoc.amountType === "fixed") ??
		catalog.prices?.find((priceDoc) => !priceDoc.isArchived) ??
		catalog.prices?.[0];
	const meteredPrice =
		catalog.prices?.find((priceDoc) => !priceDoc.isArchived && priceDoc.amountType === "metered_unit") ?? null;
	const benefitDescriptions = billing_active_plan_benefit_descriptions(billingProduct, catalog.benefits);
	const intervalLabel = billing_active_plan_interval_label(
		recurringPrice?.recurringInterval ?? catalog.recurringInterval ?? null,
	);
	const meterName = meteredPrice?.meter?.name ?? billingProduct?.meter.displayName ?? null;
	const unitPriceAmount =
		billingProduct?.meter.unitPrice?.amount ??
		(meteredPrice?.unitAmount === undefined || meteredPrice?.unitAmount === null
			? null
			: typeof meteredPrice.unitAmount === "number"
				? meteredPrice.unitAmount
				: Number(meteredPrice.unitAmount));
	const statePresentation = billing_active_plan_state_presentation(subscription);
	const title = billingProduct?.displayName ?? catalog.name;

	const meteredLine = meteredPrice
		? usage?.meter == null || usage.subscription == null
			? { kind: "loading" as const }
			: {
					kind: "ready" as const,
					due: billing_active_plan_format_minor_currency(usage.meter.amountDueCents, usage.subscription.currency),
					creditsLeft:
						unitPriceAmount != null
							? billing_active_plan_format_major_currency(
									Math.max(0, usage.meter.balance) * unitPriceAmount,
									usage.subscription.currency,
								)
							: `${usage.meter.balance} units`,
				}
		: null;

	return (
		<div
			className={
				"MainAppAccountManagementBillingActivePlan" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
			}
		>
			<div
				className={cn(
					"MainAppAccountManagementBillingActivePlan-badge" satisfies MainAppAccountManagementBillingActivePlan_ClassNames,
					statePresentation.badgeClassName,
				)}
			>
				{statePresentation.badgeLabel}
			</div>
			<div
				className={
					"MainAppAccountManagementBillingActivePlan-title" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
				}
			>
				{title}
			</div>
			<MainAppAccountManagementBillingActivePlanUsage meteredLine={meteredLine} />
			{statePresentation.primaryLine ? (
				<p
					className={
						"MainAppAccountManagementBillingActivePlan-renewal" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
					}
				>
					{statePresentation.primaryLine}
				</p>
			) : null}
			{statePresentation.secondaryLine ? (
				<p
					className={
						"MainAppAccountManagementBillingActivePlan-started" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
					}
				>
					{statePresentation.secondaryLine}
				</p>
			) : null}
			<div
				className={
					"MainAppAccountManagementBillingActivePlan-details" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
				}
			>
				<ul
					className={
						"MainAppAccountManagementBillingActivePlan-list" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
					}
				>
					{benefitDescriptions.length ? (
						<li
							className={
								"MainAppAccountManagementBillingActivePlan-list-item" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
							}
						>
							{benefitDescriptions.join(" | ")}
						</li>
					) : null}
					<li
						className={
							"MainAppAccountManagementBillingActivePlan-list-item" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
						}
					>
						Billed {intervalLabel}
						{meterName ? ` | ${meterName}` : ""}
					</li>
				</ul>
			</div>
		</div>
	);
});
