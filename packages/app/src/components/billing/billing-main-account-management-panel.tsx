import "./billing-main-account-management-panel.css";

import { CheckoutLink } from "@convex-dev/polar/react";
import { billing_PRODUCTS, billing_product_matches_polar_name } from "../../../shared/billing.ts";
import { useAction, useQuery } from "convex/react";
import { memo, type ReactNode } from "react";
import { toast } from "sonner";

import type { AppAuthContextValue } from "@/components/app-auth.tsx";
import {
	MainAppAccountManagementBillingActivePlan,
	MainAppAccountManagementBillingActivePlanSkeleton,
} from "@/components/billing/billing-active-plan.tsx";
import {
	MainAppAccountManagementBillingProductCard,
	MainAppAccountManagementBillingProductCardSkeleton,
} from "@/components/billing/billing-product-card.tsx";
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
type MainAppAccountManagementBillingHeader_ClassNames =
	| "MainAppAccountManagementBillingHeader"
	| "MainAppAccountManagementBillingHeader-title"
	| "MainAppAccountManagementBillingHeader-description";

type MainAppAccountManagementBillingHeader_Props = {
	children: ReactNode;
};

const MainAppAccountManagementBillingHeader = memo(function MainAppAccountManagementBillingHeader(
	props: MainAppAccountManagementBillingHeader_Props,
) {
	const { children } = props;

	return (
		<header
			className={"MainAppAccountManagementBillingHeader" satisfies MainAppAccountManagementBillingHeader_ClassNames}
		>
			<h2
				className={
					"MainAppAccountManagementBillingHeader-title" satisfies MainAppAccountManagementBillingHeader_ClassNames
				}
			>
				Billing
			</h2>
			<p
				className={
					"MainAppAccountManagementBillingHeader-description" satisfies MainAppAccountManagementBillingHeader_ClassNames
				}
			>
				{children}
			</p>
		</header>
	);
});
// #endregion header

// #region plans
type MainAppAccountManagementBillingPlans_ClassNames =
	| "MainAppAccountManagementBillingPlans"
	| "MainAppAccountManagementBillingPlans-title"
	| "MainAppAccountManagementBillingPlans-list";

type MainAppAccountManagementBillingPlans_Props = {
	title: ReactNode;
	children: ReactNode;
};

const MainAppAccountManagementBillingPlans = memo(function MainAppAccountManagementBillingPlans(
	props: MainAppAccountManagementBillingPlans_Props,
) {
	const { title, children } = props;

	return (
		<section
			className={"MainAppAccountManagementBillingPlans" satisfies MainAppAccountManagementBillingPlans_ClassNames}
		>
			<h3
				className={
					"MainAppAccountManagementBillingPlans-title" satisfies MainAppAccountManagementBillingPlans_ClassNames
				}
			>
				{title}
			</h3>
			<div
				className={
					"MainAppAccountManagementBillingPlans-list" satisfies MainAppAccountManagementBillingPlans_ClassNames
				}
			>
				{children}
			</div>
		</section>
	);
});
// #endregion plans

// #region plan item
type MainAppAccountManagementBillingPlanItem_ClassNames = "MainAppAccountManagementBillingPlanItem";

type MainAppAccountManagementBillingPlanItem_Props = {
	children: ReactNode;
};

const MainAppAccountManagementBillingPlanItem = memo(function MainAppAccountManagementBillingPlanItem(
	props: MainAppAccountManagementBillingPlanItem_Props,
) {
	const { children } = props;

	return (
		<div
			className={"MainAppAccountManagementBillingPlanItem" satisfies MainAppAccountManagementBillingPlanItem_ClassNames}
		>
			{children}
		</div>
	);
});
// #endregion plan item

// #region actions
type MainAppAccountManagementBillingActions_ClassNames = "MainAppAccountManagementBillingActions";

type MainAppAccountManagementBillingActions_Props = {
	children: ReactNode;
};

const MainAppAccountManagementBillingActions = memo(function MainAppAccountManagementBillingActions(
	props: MainAppAccountManagementBillingActions_Props,
) {
	const { children } = props;

	return (
		<div
			className={"MainAppAccountManagementBillingActions" satisfies MainAppAccountManagementBillingActions_ClassNames}
		>
			{children}
		</div>
	);
});
// #endregion actions

// #region root
type MainAppAccountManagementBilling_ClassNames =
	| "MainAppAccountManagementBilling"
	| "MainAppAccountManagementBilling-checkout"
	| "MainAppAccountManagementBilling-manage-subscription";

type MainAppAccountManagementBilling_Props = {
	isAnonymous: NonNullable<AppAuthContextValue["isAnonymous"]>;
};

export const MainAppAccountManagementBilling = memo(function MainAppAccountManagementBilling(
	props: MainAppAccountManagementBilling_Props,
) {
	const { isAnonymous } = props;

	const billingProducts = useQuery(app_convex_api.billing.list_products, isAnonymous ? "skip" : {});
	const billingSubscriptions = useQuery(app_convex_api.billing.list_subscriptions, isAnonymous ? "skip" : {});
	const billingUsage = useQuery(app_convex_api.billing.get_usage_snapshot, isAnonymous ? "skip" : {});

	const generateCustomerPortalUrl = useAction(app_convex_api.billing.generate_customer_portal_url);

	const handleManageSubscription = useFn(() => {
		void generateCustomerPortalUrl({})
			.then((result) => {
				if (result?.url) {
					window.open(result.url, "_blank", "noopener,noreferrer");
				} else {
					const message = "Could not open subscription management";
					console.error(message, { result });
					toast.error(message);
				}
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
	const curatedCheckoutCatalog = billingProducts
		? (billingProducts.find((product) => {
				return billing_product_matches_polar_name(product.name, billing_PRODUCTS["Pay As You Go"]);
			}) ?? null)
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
		<div className={"MainAppAccountManagementBilling" satisfies MainAppAccountManagementBilling_ClassNames}>
			{isAnonymous ? (
				<MainAppAccountManagementBillingHeader>
					Sign in to manage your plan, billing, and invoices.
				</MainAppAccountManagementBillingHeader>
			) : billingProducts === undefined || billingSubscriptions === undefined || billingUsage === undefined ? (
				<>
					<MainAppAccountManagementBillingHeader>Loading your billing details...</MainAppAccountManagementBillingHeader>
					<MainAppAccountManagementBillingPlans title="Plans">
						<MainAppAccountManagementBillingActivePlanSkeleton />
						<MainAppAccountManagementBillingProductCardSkeleton />
						<MainAppAccountManagementBillingProductCardSkeleton />
					</MainAppAccountManagementBillingPlans>
				</>
			) : activeSubscription != null && activeCatalog == null ? (
				<MainAppAccountManagementBillingHeader>
					Failed to load product detail for the subscription.
				</MainAppAccountManagementBillingHeader>
			) : activeSubscription == null && billingProducts.length === 0 ? (
				<MainAppAccountManagementBillingHeader>
					Billing plans aren't available right now. Please check back soon.
				</MainAppAccountManagementBillingHeader>
			) : (
				<>
					<MainAppAccountManagementBillingHeader>{headerDescription}</MainAppAccountManagementBillingHeader>

					{activeSubscription != null && activeCatalog != null && otherCatalogs != null ? (
						<>
							<MainAppAccountManagementBillingActivePlan
								catalog={activeCatalog}
								subscription={activeSubscription}
								usage={billingUsage}
							/>
							<MainAppAccountManagementBillingActions>
								<MyButton
									type="button"
									variant="outline"
									className={
										"MainAppAccountManagementBilling-manage-subscription" satisfies MainAppAccountManagementBilling_ClassNames
									}
									onClick={handleManageSubscription}
								>
									Manage subscription
								</MyButton>
							</MainAppAccountManagementBillingActions>
							{otherCatalogs.length ? (
								<MainAppAccountManagementBillingPlans title="Other plans">
									{otherCatalogs.map((product) => (
										<MainAppAccountManagementBillingPlanItem key={product.id}>
											<MainAppAccountManagementBillingProductCard product={product} />
										</MainAppAccountManagementBillingPlanItem>
									))}
								</MainAppAccountManagementBillingPlans>
							) : null}
						</>
					) : (
						<MainAppAccountManagementBillingPlans title="Available plans">
							{billingProducts.map((product) => {
								const showCheckout = curatedCheckoutCatalog != null && product.id === curatedCheckoutCatalog.id;

								return (
									<MainAppAccountManagementBillingPlanItem key={product.id}>
										<MainAppAccountManagementBillingProductCard product={product} />
										{showCheckout ? (
											<MainAppAccountManagementBillingActions>
												<CheckoutLink
													polarApi={{
														generateCheckoutLink: app_convex_api.billing.generate_checkout_link,
													}}
													productIds={[product.id]}
													embed={false}
													lazy
													className={
														"MainAppAccountManagementBilling-checkout" satisfies MainAppAccountManagementBilling_ClassNames
													}
												>
													Checkout
												</CheckoutLink>
											</MainAppAccountManagementBillingActions>
										) : null}
									</MainAppAccountManagementBillingPlanItem>
								);
							})}
						</MainAppAccountManagementBillingPlans>
					)}
				</>
			)}
		</div>
	);
});
// #endregion root
