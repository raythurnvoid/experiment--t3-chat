import "./main-app-header-billing-indicator.css";

import { memo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { CircleHelp, TriangleAlert } from "lucide-react";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipInfoTrigger } from "@/components/my-tooltip.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { format_cents } from "@/lib/currency.ts";
import { cn } from "@/lib/utils.ts";

// #region due
type MainAppHeaderBillingIndicatorDue_ClassNames =
	| "MainAppHeaderBillingIndicatorDue"
	| "MainAppHeaderBillingIndicatorDue-label"
	| "MainAppHeaderBillingIndicatorDue-value"
	| "MainAppHeaderBillingIndicatorDue-help";

type MainAppHeaderBillingIndicatorDue_Props = {
	value: string;
	isFree: boolean;
};

const MainAppHeaderBillingIndicatorDue = memo(function MainAppHeaderBillingIndicatorDue(
	props: MainAppHeaderBillingIndicatorDue_Props,
) {
	const { value, isFree } = props;

	return (
		<MyTooltip placement="bottom" open={isFree ? undefined : false}>
			<MyTooltipInfoTrigger disabled={!isFree}>
				<span className={cn("MainAppHeaderBillingIndicatorDue" satisfies MainAppHeaderBillingIndicatorDue_ClassNames)}>
					<span className={cn("MainAppHeaderBillingIndicatorDue-label" satisfies MainAppHeaderBillingIndicatorDue_ClassNames)}>
						Due
					</span>
					<span className={cn("MainAppHeaderBillingIndicatorDue-value" satisfies MainAppHeaderBillingIndicatorDue_ClassNames)}>
						{value}
					</span>
					{isFree ? (
						<CircleHelp
							className={cn("MainAppHeaderBillingIndicatorDue-help" satisfies MainAppHeaderBillingIndicatorDue_ClassNames)}
							aria-hidden
						/>
					) : null}
				</span>
			</MyTooltipInfoTrigger>
			<MyTooltipContent unmountOnHide>
				<>
					You're on the Free plan. The app is free to use until your monthly credits run out, then you'll be
					blocked until the next cycle or an upgrade.
				</>
			</MyTooltipContent>
		</MyTooltip>
	);
});
// #endregion due

// #region remaining
type MainAppHeaderBillingIndicatorRemaining_ClassNames =
	| "MainAppHeaderBillingIndicatorRemaining"
	| "MainAppHeaderBillingIndicatorRemaining-label"
	| "MainAppHeaderBillingIndicatorRemaining-value"
	| "MainAppHeaderBillingIndicatorRemaining-value-exhausted"
	| "MainAppHeaderBillingIndicatorRemaining-warn";

type MainAppHeaderBillingIndicatorRemaining_Props = {
	value: string;
	isExhausted: boolean;
};

const MainAppHeaderBillingIndicatorRemaining = memo(function MainAppHeaderBillingIndicatorRemaining(
	props: MainAppHeaderBillingIndicatorRemaining_Props,
) {
	const { value, isExhausted } = props;
	const exhaustedReason = isExhausted ? "Out of funds" : null;

	return (
		<MyTooltip placement="bottom" open={exhaustedReason ? undefined : false}>
			<MyTooltipInfoTrigger disabled={!exhaustedReason}>
				<span
					className={cn(
						"MainAppHeaderBillingIndicatorRemaining" satisfies MainAppHeaderBillingIndicatorRemaining_ClassNames,
					)}
				>
					<span
						className={cn(
							"MainAppHeaderBillingIndicatorRemaining-label" satisfies MainAppHeaderBillingIndicatorRemaining_ClassNames,
						)}
					>
						Remaining
					</span>
					<span
						className={cn(
							"MainAppHeaderBillingIndicatorRemaining-value" satisfies MainAppHeaderBillingIndicatorRemaining_ClassNames,
							isExhausted &&
								("MainAppHeaderBillingIndicatorRemaining-value-exhausted" satisfies MainAppHeaderBillingIndicatorRemaining_ClassNames),
						)}
					>
						{value}
					</span>
					{isExhausted ? (
						<TriangleAlert
							className={cn(
								"MainAppHeaderBillingIndicatorRemaining-warn" satisfies MainAppHeaderBillingIndicatorRemaining_ClassNames,
							)}
							aria-hidden
						/>
					) : null}
				</span>
			</MyTooltipInfoTrigger>
			<MyTooltipContent unmountOnHide>
				<>{exhaustedReason}</>
			</MyTooltipContent>
		</MyTooltip>
	);
});
// #endregion remaining

// #region root
type MainAppHeaderBillingIndicator_ClassNames = "MainAppHeaderBillingIndicator" | "MainAppHeaderBillingIndicator-sep";

export const MainAppHeaderBillingIndicator = memo(function MainAppHeaderBillingIndicator() {
	const auth = AppAuthProvider.useAuth();
	const convexAuth = useConvexAuth();

	const shouldQuery = auth.isLoaded && auth.isAuthenticated && convexAuth.isAuthenticated && auth.isAnonymous === false;

	const subscription = useQuery(app_convex_api.billing.get_current_user_subscription, shouldQuery ? {} : "skip");
	const billingUsageSnapshot = useQuery(app_convex_api.billing.get_usage_snapshot, shouldQuery ? {} : "skip");
	const products = useQuery(app_convex_api.billing.list_products, shouldQuery ? {} : "skip");

	if (!shouldQuery) {
		return null;
	}

	// Root layout gates children on billing bootstrap, so the subscription and
	// the snapshot subscription metadata must be present. The customer meter is
	// the authoritative source for remaining credits and amount due, so hide the
	// indicator until Polar has synced it for this user.
	if (
		!subscription ||
		!billingUsageSnapshot?.subscription ||
		billingUsageSnapshot.polarCustomerId == null ||
		billingUsageSnapshot.subscription.id == null ||
		!billingUsageSnapshot.meter ||
		billingUsageSnapshot.meter.id == null ||
		!products
	) {
		return null;
	}

	const activeProduct = products.find((product) => product.id === subscription.productId) ?? null;
	if (!activeProduct) {
		return null;
	}
	const isFree = activeProduct.name === "Free";

	const currency = billingUsageSnapshot.subscription.currency;
	const dueText = format_cents(billingUsageSnapshot.meter.amountDueCents, currency);
	const remainingCents = billingUsageSnapshot.meter.balance;
	const creditsLeftText = format_cents(remainingCents, currency);
	const isExhausted = remainingCents < 0;

	return (
		<div className={cn("MainAppHeaderBillingIndicator" satisfies MainAppHeaderBillingIndicator_ClassNames)}>
			<MainAppHeaderBillingIndicatorDue value={dueText} isFree={isFree} />
			<span className={cn("MainAppHeaderBillingIndicator-sep" satisfies MainAppHeaderBillingIndicator_ClassNames)}>
				|
			</span>
			<MainAppHeaderBillingIndicatorRemaining value={creditsLeftText} isExhausted={isExhausted} />
		</div>
	);
});
// #endregion root
