import "./__root.css";
import { createRootRoute, Outlet, type ErrorComponentProps } from "@tanstack/react-router";
import { memo, useEffect } from "react";
import { Logo } from "../components/logo.tsx";
import { MySpinner } from "../components/my-spinner.tsx";
import { AppAuthProvider } from "../components/app-auth.tsx";
import { AppTanStackRouterDevTools } from "../components/app-tanstack-router-dev-tools.tsx";
import { AppRouteError } from "../components/app-route-error.tsx";
import { cn, valorize_scrollbar_width_px_css_var } from "../lib/utils.ts";
import type { AppElementId } from "../lib/dom-utils.ts";
import { useConvexAuth } from "convex/react";

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
					Finish loading authentication and workspace access.
				</div>
			</div>
		</div>
	);
}

function RootLayout() {
	const auth = AppAuthProvider.useAuth();
	const convexAuth = useConvexAuth();

	const isLoading = convexAuth.isLoading || !auth.isLoaded;
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
