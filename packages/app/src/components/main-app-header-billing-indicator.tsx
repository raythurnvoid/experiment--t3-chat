import "./main-app-header-billing-indicator.css";

import { memo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { CircleHelp } from "lucide-react";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipInfoTrigger } from "@/components/my-tooltip.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { format_cents } from "@/lib/currency.ts";
import { cn } from "@/lib/utils.ts";

const FREE_PLAN_TOOLTIP =
	"You're on the Free plan. The app is free to use until your monthly credits run out, then you'll be blocked until the next cycle or an upgrade.";

type MainAppHeaderBillingIndicator_ClassNames =
	| "MainAppHeaderBillingIndicator"
	| "MainAppHeaderBillingIndicator-group"
	| "MainAppHeaderBillingIndicator-label"
	| "MainAppHeaderBillingIndicator-value"
	| "MainAppHeaderBillingIndicator-sep"
	| "MainAppHeaderBillingIndicator-help";

export const MainAppHeaderBillingIndicator = memo(function MainAppHeaderBillingIndicator() {
	const auth = AppAuthProvider.useAuth();
	const convexAuth = useConvexAuth();

	const shouldQuery = auth.isLoaded && auth.isAuthenticated && convexAuth.isAuthenticated && auth.isAnonymous === false;

	const subscription = useQuery(app_convex_api.billing.get_current_user_subscription, shouldQuery ? {} : "skip");
	const usage = useQuery(app_convex_api.billing.get_usage_snapshot, shouldQuery ? {} : "skip");
	const products = useQuery(app_convex_api.billing.list_products, shouldQuery ? {} : "skip");

	if (!shouldQuery) {
		return null;
	}

	// Root layout gates children on billing bootstrap, so the subscription and
	// the snapshot subscription metadata must be present. The customer meter is
	// the authoritative source for remaining credits and amount due, so hide the
	// indicator until Polar has synced it for this user.
	if (!subscription || !usage?.subscription || !usage.meter || !products) {
		return null;
	}

	const activeProduct = products.find((product) => product.id === subscription.productId) ?? null;
	if (!activeProduct) {
		return null;
	}
	const isFree = activeProduct.name === "Free";

	const currency = usage.subscription.currency;
	const dueText = format_cents(usage.meter.amountDueCents, currency);
	const creditsLeftText = format_cents(usage.meter.balance, currency);
	const dueGroupContent = (
		<span className={cn("MainAppHeaderBillingIndicator-group" satisfies MainAppHeaderBillingIndicator_ClassNames)}>
			<span className={cn("MainAppHeaderBillingIndicator-label" satisfies MainAppHeaderBillingIndicator_ClassNames)}>
				Due
			</span>
			<span className={cn("MainAppHeaderBillingIndicator-value" satisfies MainAppHeaderBillingIndicator_ClassNames)}>
				{dueText}
			</span>
			{isFree && (
				<CircleHelp
					className={cn("MainAppHeaderBillingIndicator-help" satisfies MainAppHeaderBillingIndicator_ClassNames)}
					aria-hidden
				/>
			)}
		</span>
	);

	return (
		<div className={cn("MainAppHeaderBillingIndicator" satisfies MainAppHeaderBillingIndicator_ClassNames)}>
			{isFree ? (
				<MyTooltip placement="bottom">
					<MyTooltipInfoTrigger>{dueGroupContent}</MyTooltipInfoTrigger>
					<MyTooltipContent unmountOnHide>
						<>{FREE_PLAN_TOOLTIP}</>
					</MyTooltipContent>
				</MyTooltip>
			) : (
				dueGroupContent
			)}
			<span className={cn("MainAppHeaderBillingIndicator-sep" satisfies MainAppHeaderBillingIndicator_ClassNames)}>
				|
			</span>
			<span className={cn("MainAppHeaderBillingIndicator-group" satisfies MainAppHeaderBillingIndicator_ClassNames)}>
				<span className={cn("MainAppHeaderBillingIndicator-label" satisfies MainAppHeaderBillingIndicator_ClassNames)}>
					Remaining
				</span>
				<span className={cn("MainAppHeaderBillingIndicator-value" satisfies MainAppHeaderBillingIndicator_ClassNames)}>
					{creditsLeftText}
				</span>
			</span>
		</div>
	);
});
