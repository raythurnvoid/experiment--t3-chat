import "./billing-account-management-panel.css";

import { useConvex, useQuery } from "convex/react";
import { memo, type ReactNode } from "react";
import { toast } from "sonner";

import type { AppAuthContextValue } from "@/components/app-auth.tsx";
import { BillingActivePlan, BillingActivePlanSkeleton } from "@/components/billing/billing-active-plan.tsx";
import { BillingCheckoutButton } from "@/components/billing/billing-checkout-button.tsx";
import { BillingProductCard, BillingProductCardSkeleton } from "@/components/billing/billing-product-card.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { format_time } from "@/lib/date.ts";

function find_active_subscription(
	subscriptions: app_convex_FunctionReturnType<typeof app_convex_api.billing.list_subscriptions>,
) {
	return subscriptions.find((subscription) => {
		return (subscription.status === "active" || subscription.status === "trialing") && !subscription.endedAt;
	});
}

// #region header
type BillingAccountManagementPanelHeader_ClassNames =
	| "BillingAccountManagementPanelHeader"
	| "BillingAccountManagementPanelHeader-title"
	| "BillingAccountManagementPanelHeader-description";

type BillingAccountManagementPanelHeader_Props = {
	children: ReactNode;
};

const BillingAccountManagementPanelHeader = memo(function BillingAccountManagementPanelHeader(
	props: BillingAccountManagementPanelHeader_Props,
) {
	const { children } = props;

	return (
		<header className={"BillingAccountManagementPanelHeader" satisfies BillingAccountManagementPanelHeader_ClassNames}>
			<h2
				className={"BillingAccountManagementPanelHeader-title" satisfies BillingAccountManagementPanelHeader_ClassNames}
			>
				Billing
			</h2>
			<p
				className={
					"BillingAccountManagementPanelHeader-description" satisfies BillingAccountManagementPanelHeader_ClassNames
				}
			>
				{children}
			</p>
		</header>
	);
});
// #endregion header

// #region plans
type BillingAccountManagementPanelPlans_ClassNames =
	| "BillingAccountManagementPanelPlans"
	| "BillingAccountManagementPanelPlans-title"
	| "BillingAccountManagementPanelPlans-list";

type BillingAccountManagementPanelPlans_Props = {
	title: ReactNode;
	children: ReactNode;
};

const BillingAccountManagementPanelPlans = memo(function BillingAccountManagementPanelPlans(
	props: BillingAccountManagementPanelPlans_Props,
) {
	const { title, children } = props;

	return (
		<section className={"BillingAccountManagementPanelPlans" satisfies BillingAccountManagementPanelPlans_ClassNames}>
			<h3
				className={"BillingAccountManagementPanelPlans-title" satisfies BillingAccountManagementPanelPlans_ClassNames}
			>
				{title}
			</h3>
			<div
				className={"BillingAccountManagementPanelPlans-list" satisfies BillingAccountManagementPanelPlans_ClassNames}
			>
				{children}
			</div>
		</section>
	);
});
// #endregion plans

// #region plan item
type BillingAccountManagementPanelPlanItem_ClassNames = "BillingAccountManagementPanelPlanItem";

type BillingAccountManagementPanelPlanItem_Props = {
	children: ReactNode;
};

const BillingAccountManagementPanelPlanItem = memo(function BillingAccountManagementPanelPlanItem(
	props: BillingAccountManagementPanelPlanItem_Props,
) {
	const { children } = props;

	return (
		<div className={"BillingAccountManagementPanelPlanItem" satisfies BillingAccountManagementPanelPlanItem_ClassNames}>
			{children}
		</div>
	);
});
// #endregion plan item

// #region actions
type BillingAccountManagementPanelActions_ClassNames = "BillingAccountManagementPanelActions";

type BillingAccountManagementPanelActions_Props = {
	children: ReactNode;
};

const BillingAccountManagementPanelActions = memo(function BillingAccountManagementPanelActions(
	props: BillingAccountManagementPanelActions_Props,
) {
	const { children } = props;

	return (
		<div className={"BillingAccountManagementPanelActions" satisfies BillingAccountManagementPanelActions_ClassNames}>
			{children}
		</div>
	);
});
// #endregion actions

// #region root
type BillingAccountManagementPanel_ClassNames =
	| "BillingAccountManagementPanel"
	| "BillingAccountManagementPanel-manage-subscription";

type BillingAccountManagementPanel_Props = {
	isAnonymous: NonNullable<AppAuthContextValue["isAnonymous"]>;
};

export const BillingAccountManagementPanel = memo(function BillingAccountManagementPanel(
	props: BillingAccountManagementPanel_Props,
) {
	const { isAnonymous } = props;

	const billingProducts = useQuery(app_convex_api.billing.list_products, isAnonymous ? "skip" : {});
	const billingSubscriptions = useQuery(app_convex_api.billing.list_subscriptions, isAnonymous ? "skip" : {});
	const billingUsage = useQuery(app_convex_api.billing.get_usage_snapshot, isAnonymous ? "skip" : {});
	const convex = useConvex();

	const handleManageSubscription = useFn(() => {
		void convex
			.action(app_convex_api.billing.generate_customer_portal_url, {})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message ?? "Could not open subscription management");
					return;
				}

				window.open(result._yay.url, "_blank", "noopener,noreferrer");
			})
			.catch((e) => {
				const error = e as Error;
				console.error(error);
				toast.error(error.message);
			});
	});

	const activeSubscription = billingSubscriptions ? (find_active_subscription(billingSubscriptions) ?? null) : null;
	const activeCatalog =
		activeSubscription && billingProducts
			? (billingProducts.find((product) => product.id === activeSubscription.productId) ?? null)
			: null;
	const otherCatalogs = billingProducts
		? billingProducts.filter((product) => {
				return product.id !== activeSubscription?.productId;
			})
		: null;
	const headerDescription = ((/* iife */) => {
		if (activeSubscription?.cancelAtPeriodEnd) {
			const endsAt = activeSubscription.endsAt ?? activeSubscription.currentPeriodEnd;
			if (endsAt) {
				return `Your subscription remains active until ${format_time(Date.parse(endsAt))}. Click Manage subscription to review the scheduled cancellation.`;
			}
			return "Your subscription is cancelled. Click Manage subscription to review the details.";
		}
		if (activeSubscription != null) {
			return "Your subscription is active. Check the plan information below or click Manage subscription to review the details.";
		}
		return "Review the available plans below and choose the option that fits how you want to use the app.";
	})();

	return (
		<div className={"BillingAccountManagementPanel" satisfies BillingAccountManagementPanel_ClassNames}>
			{isAnonymous ? (
				<BillingAccountManagementPanelHeader>
					Sign in to manage your plan, billing, and invoices.
				</BillingAccountManagementPanelHeader>
			) : billingProducts === undefined || billingSubscriptions === undefined || billingUsage === undefined ? (
				<>
					<BillingAccountManagementPanelHeader>Loading your billing details...</BillingAccountManagementPanelHeader>
					<BillingAccountManagementPanelPlans title="Plans">
						<BillingActivePlanSkeleton />
						<BillingProductCardSkeleton />
						<BillingProductCardSkeleton />
					</BillingAccountManagementPanelPlans>
				</>
			) : activeSubscription != null && activeCatalog == null ? (
				<BillingAccountManagementPanelHeader>
					Failed to load product detail for the subscription.
				</BillingAccountManagementPanelHeader>
			) : activeSubscription == null && billingProducts.length === 0 ? (
				<BillingAccountManagementPanelHeader>
					Billing plans aren't available right now. Please check back soon.
				</BillingAccountManagementPanelHeader>
			) : (
				<>
					<BillingAccountManagementPanelHeader>{headerDescription}</BillingAccountManagementPanelHeader>

					{activeSubscription != null && activeCatalog != null && otherCatalogs != null ? (
						<>
							<BillingActivePlan product={activeCatalog} subscription={activeSubscription} usage={billingUsage} />
							<BillingAccountManagementPanelActions>
								<MyButton
									type="button"
									variant="outline"
									className={
										"BillingAccountManagementPanel-manage-subscription" satisfies BillingAccountManagementPanel_ClassNames
									}
									onClick={handleManageSubscription}
								>
									Manage subscription
								</MyButton>
							</BillingAccountManagementPanelActions>
							{otherCatalogs.length ? (
								<BillingAccountManagementPanelPlans title="Other plans">
									{otherCatalogs.map((product) => (
										<BillingAccountManagementPanelPlanItem key={product.id}>
											<BillingProductCard
												product={product}
												selectPlanSlot={<BillingCheckoutButton productId={product.id} />}
											/>
										</BillingAccountManagementPanelPlanItem>
									))}
								</BillingAccountManagementPanelPlans>
							) : null}
						</>
					) : (
						<BillingAccountManagementPanelPlans title="Available plans">
							{billingProducts.map((product) => {
								return (
									<BillingAccountManagementPanelPlanItem key={product.id}>
										<BillingProductCard product={product} selectPlanSlot={<BillingCheckoutButton productId={product.id} />} />
									</BillingAccountManagementPanelPlanItem>
								);
							})}
						</BillingAccountManagementPanelPlans>
					)}
				</>
			)}
		</div>
	);
});
// #endregion root
