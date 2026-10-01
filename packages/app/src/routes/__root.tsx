import "./__root.css";
import {
	createRootRoute,
	DefaultGlobalNotFound,
	Outlet,
	useRouterState,
	type ErrorComponentProps,
} from "@tanstack/react-router";
import { memo, useEffect } from "react";
import { useConvexAuth, useQuery } from "convex/react";

import { AppAuthProvider } from "../components/app-auth.tsx";
import { AppLoadingCard } from "../components/app-loading-card.tsx";
import { AppTanStackRouterDevTools } from "../components/app-tanstack-router-dev-tools.tsx";
import { AppRouteError } from "../components/app-route-error.tsx";
import { FilesShareUnavailable } from "../components/files/files-share-frame.tsx";
import { app_convex_api, type app_convex_FunctionReturnType } from "../lib/app-convex-client.ts";
import { app_scrollbar_measure_width } from "../lib/app-scrollbar.ts";
import type { AppElementId } from "../lib/dom-utils.ts";
import { url_is_share_path } from "../lib/urls.ts";
import { PluginsPublishSessionProvider } from "../components/plugins-publish-session.tsx";

export type RootLayout_ClassNames = "RootLayout" | "RootLayout-content";

type RootLayout_CustomAttributes = {
	"data-app-ready": "";
};

/**
 * Read the router pathname: no base path, static segments decoded. `main.tsx` picks the providers
 * with the same pathname and helper, so the root and the providers always agree.
 */
function useIsSharePath() {
	return url_is_share_path(useRouterState({ select: (state) => state.location.pathname }));
}

const RootRouteError = memo(function RootRouteError(props: ErrorComponentProps) {
	const isSharePath = useIsSharePath();

	// The public share page shows only its generic message. Error details could hold the token or text.
	if (isSharePath) {
		return <FilesShareUnavailable />;
	}

	return <AppRouteError {...props} layout="fullscreen" />;
});

const RootRouteNotFound = memo(function RootRouteNotFound() {
	const isSharePath = useIsSharePath();

	// A broken or unknown path under the share prefix gets the same message as a link that was turned off.
	if (isSharePath) {
		return <FilesShareUnavailable />;
	}

	return <DefaultGlobalNotFound />;
});

type RootLayout_CurrentSubscription = app_convex_FunctionReturnType<
	typeof app_convex_api.billing.get_current_user_subscription
>;
type RootLayout_UsageSnapshot = app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>;

function billing_is_loading(args: {
	subscription: RootLayout_CurrentSubscription | undefined;
	billingUsageSnapshot: RootLayout_UsageSnapshot | undefined;
}) {
	if (args.subscription === undefined) {
		return true;
	}

	if (!args.subscription) {
		return false;
	}

	if (args.billingUsageSnapshot === undefined) {
		return true;
	}

	return (
		!args.billingUsageSnapshot?.subscription ||
		args.billingUsageSnapshot.subscription.id == null ||
		args.billingUsageSnapshot.subscription.id !== args.subscription.id ||
		args.billingUsageSnapshot.subscription.productId !== args.subscription.productId
	);
}

function RootLayoutInner() {
	useEffect(() => {
		app_scrollbar_measure_width();

		// Browser QA waits on this attribute instead of polling route content. It appears only
		// after auth, organization access, and billing bootstrap have all finished.
		document.documentElement.setAttribute("data-app-ready" satisfies keyof RootLayout_CustomAttributes, "");
		return () => {
			document.documentElement.removeAttribute("data-app-ready" satisfies keyof RootLayout_CustomAttributes);
		};
	}, []);

	return (
		<PluginsPublishSessionProvider>
			<Outlet />
			<AppTanStackRouterDevTools />
			<div id={"app_tiptap_hoisting_container" satisfies AppElementId}></div>
			{/* The monaco hoisting container requires the monaco-editor class to style the widgets */}
			<div id={"app_monaco_hoisting_container" satisfies AppElementId} className="monaco-editor"></div>
			{/*
			This must be at the bottom to ensure that regular floating elements
			opened from tiptap and monaco floating elements are shown on top.
			*/}
			<div id={"app_hoisting_container" satisfies AppElementId}></div>
		</PluginsPublishSessionProvider>
	);
}

type RootLayoutPublic_ClassNames = "RootLayoutPublic";

/**
 * The share page root. It loads without sign-in, so it renders no auth, billing, plugin session, or
 * dev tools, and never sets `data-app-ready`.
 */
function RootLayoutPublic() {
	useEffect(() => {
		app_scrollbar_measure_width();
	}, []);

	return (
		<>
			<Outlet />
			<div
				id={"app_hoisting_container" satisfies AppElementId}
				className={"RootLayoutPublic" satisfies RootLayoutPublic_ClassNames}
			></div>
		</>
	);
}

function RootLayoutPrivate() {
	const auth = AppAuthProvider.useAuth();
	const convexAuth = useConvexAuth();
	const shouldWaitForBillingBootstrap =
		auth.isLoaded && auth.isAuthenticated && convexAuth.isAuthenticated && auth.isAnonymous === false;
	const billingSubscription = useQuery(
		app_convex_api.billing.get_current_user_subscription,
		shouldWaitForBillingBootstrap ? {} : "skip",
	);
	const billingUsageSnapshot = useQuery(
		app_convex_api.billing.get_usage_snapshot,
		shouldWaitForBillingBootstrap ? {} : "skip",
	);
	const isBillingBootstrapLoading =
		shouldWaitForBillingBootstrap &&
		billing_is_loading({
			subscription: billingSubscription,
			billingUsageSnapshot,
		});

	// TODO: Waiting for billing adds one round trip (about 130 ms) to every page load. Keep the wait for now:
	// the app must know whether the user pays before it offers paid features, or a user could reach them
	// before the plan loads. Remove it only if every paid feature checks the plan on its own.
	const isLoading = convexAuth.isLoading || !auth.isLoaded || isBillingBootstrapLoading;
	const isHealthy = auth.isLoaded && auth.isAuthenticated && convexAuth.isAuthenticated;

	if (isLoading) {
		return (
			<AppLoadingCard
				ref={null}
				label="Preparing organization"
				title="Preparing organization"
				description="Finish loading authentication, organization access, and billing setup."
			/>
		);
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

function RootLayout() {
	const isSharePath = useIsSharePath();

	return isSharePath ? <RootLayoutPublic /> : <RootLayoutPrivate />;
}

const Route = createRootRoute({
	component: RootLayout,
	errorComponent: RootRouteError,
	notFoundComponent: RootRouteNotFound,
	onCatch: (args: unknown) => {
		// Import the router here, not at the top. The router imports the route tree, which imports this
		// file, so a top-level import breaks when this file loads first (for example in a test).
		// `main.tsx` already loaded the router, so this import does not fetch anything.
		import("../lib/app-router.ts")
			.then(({ app_router }) => {
				// Log nothing for the share page. Its errors can hold the token or the shared text.
				if (url_is_share_path(app_router().state.location.pathname)) {
					return;
				}

				console.error("[RootRoute.onCatch] Uncaught route error", { args });
			})
			.catch((error: unknown) => {
				console.error("[RootRoute.onCatch] Failed to load the router", { error });
			});
	},
});

export { Route };
