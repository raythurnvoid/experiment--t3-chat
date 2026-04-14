import "./__root.css";
import { createRootRoute, Outlet, type ErrorComponentProps } from "@tanstack/react-router";
import { memo, useEffect } from "react";
import { useConvexAuth, useQuery } from "convex/react";

import { AppAuthProvider } from "../components/app-auth.tsx";
import { Logo } from "../components/logo.tsx";
import { MySpinner } from "../components/my-spinner.tsx";
import { AppTanStackRouterDevTools } from "../components/app-tanstack-router-dev-tools.tsx";
import { AppRouteError } from "../components/app-route-error.tsx";
import { app_convex_api, type app_convex_FunctionReturnType } from "../lib/app-convex-client.ts";
import { cn, valorize_scrollbar_width_px_css_var } from "../lib/utils.ts";
import type { AppElementId } from "../lib/dom-utils.ts";

export type RootLayout_ClassNames =
	| "RootLayout"
	| "RootLayout-content"
	| "RootLayoutAuthState"
	| "RootLayoutAuthState-panel"
	| "RootLayoutAuthState-logo"
	| "RootLayoutAuthState-spinner"
	| "RootLayoutAuthState-title"
	| "RootLayoutAuthState-description";

const RootRouteError = memo(function RootRouteError(props: ErrorComponentProps) {
	return <AppRouteError {...props} layout="fullscreen" />;
});

type RootLayout_CurrentSubscription = app_convex_FunctionReturnType<
	typeof app_convex_api.billing.get_current_user_subscription
>;
type RootLayout_UsageSnapshot = app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>;

function billing_is_loading(args: {
	subscription: RootLayout_CurrentSubscription | undefined;
	usage: RootLayout_UsageSnapshot | undefined;
}) {
	if (args.subscription === undefined) {
		return true;
	}

	if (!args.subscription) {
		return false;
	}

	if (args.usage === undefined) {
		return true;
	}

	return (
		!args.usage?.subscription ||
		!args.usage.meter ||
		args.usage.subscription.id !== args.subscription.id ||
		args.usage.subscription.productId !== args.subscription.productId
	);
}

function RootLayoutInner() {
	useEffect(() => {
		valorize_scrollbar_width_px_css_var();
	}, []);

	return (
		<>
			<Outlet />
			<AppTanStackRouterDevTools />
			<div id={"app_hoisting_container" satisfies AppElementId}></div>
			<div id={"app_tiptap_hoisting_container" satisfies AppElementId}></div>
			{/* The monaco hoisting container requires the monaco-editor class to style the widgets */}
			<div id={"app_monaco_hoisting_container" satisfies AppElementId} className="monaco-editor"></div>
		</>
	);
}

function RootLayoutAuthState() {
	return (
		<div className={cn("RootLayoutAuthState" satisfies RootLayout_ClassNames)}>
			<div className={cn("RootLayoutAuthState-panel" satisfies RootLayout_ClassNames)}>
				<Logo className={"RootLayoutAuthState-logo" satisfies RootLayout_ClassNames} />
				<MySpinner
					size="24px"
					color="var(--color-accent-07)"
					className={"RootLayoutAuthState-spinner" satisfies RootLayout_ClassNames}
				/>
				<div className={"RootLayoutAuthState-title" satisfies RootLayout_ClassNames}>Preparing workspace</div>
				<div className={"RootLayoutAuthState-description" satisfies RootLayout_ClassNames}>
					Finish loading authentication, workspace access, and billing setup.
				</div>
			</div>
		</div>
	);
}

function RootLayout() {
	const auth = AppAuthProvider.useAuth();
	const convexAuth = useConvexAuth();
	const shouldWaitForBillingBootstrap =
		auth.isLoaded && auth.isAuthenticated && convexAuth.isAuthenticated && auth.isAnonymous === false;
	const billingSubscription = useQuery(app_convex_api.billing.get_current_user_subscription, shouldWaitForBillingBootstrap ? {} : "skip");
	const billingUsage = useQuery(app_convex_api.billing.get_usage_snapshot, shouldWaitForBillingBootstrap ? {} : "skip");
	const isBillingBootstrapLoading =
		shouldWaitForBillingBootstrap &&
		billing_is_loading({
			subscription: billingSubscription,
			usage: billingUsage,
		});

	const isLoading = convexAuth.isLoading || !auth.isLoaded || isBillingBootstrapLoading;
	const isHealthy = auth.isLoaded && auth.isAuthenticated && convexAuth.isAuthenticated;

	if (isLoading) {
		return <RootLayoutAuthState />;
	}

	if (isHealthy) {
		return <RootLayoutInner />;
	}

	throw new Error("Failed to start session", {
		cause: {
			auth_isLoaded: auth.isLoaded,
			auth_isAuthenticated: auth.isAuthenticated,
			auth_isAnonymous: auth.isAnonymous,
			auth_userId: auth.userId,
			convex_isLoading: convexAuth.isLoading,
			convex_isAuthenticated: convexAuth.isAuthenticated,
		},
	});
}

const Route = createRootRoute({
	component: RootLayout,
	errorComponent: RootRouteError,
	onCatch: (args: unknown) => {
		console.error("[RootRoute.onCatch] Uncaught route error", { args });
	},
});

export { Route };
